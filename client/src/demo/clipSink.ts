/** clipSink — where recorded mp4s go. Chrome's per-download save prompt
 *  fires on every anchor click, which interrupts mid-match; picking a
 *  clips folder ONCE via the File System Access API lets every later
 *  clip land silently. The handle persists in IndexedDB (handles are
 *  structured-cloneable); permission may need a one-time re-grant after
 *  restart, done lazily inside a user gesture (F9 / the pick button).
 *  Non-Chromium browsers keep the universal anchor-download path. */

export type DirHandle = {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission?(o: { mode: string }): Promise<string>;
  requestPermission?(o: { mode: string }): Promise<string>;
};

let dir: DirHandle | null = null;

const idb = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open('kribes-clips', 2);
  r.onupgradeneeded = () => {
    // 'h' = persisted dir handle, 'v' = clip vault (silent fallback sink)
    if (!r.result.objectStoreNames.contains('h')) {r.result.createObjectStore('h');}
    if (!r.result.objectStoreNames.contains('v')) {r.result.createObjectStore('v');}
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function persistDir(h: DirHandle): Promise<void> {
  try {
    const db = await idb();
    db.transaction('h', 'readwrite').objectStore('h').put(h, 'dir');
  } catch { /* persistence is a nicety, not a requirement */ }
}

// A stored handle that came back 'prompt' instead of 'granted' — kept so
// the next user gesture can re-grant it instead of re-picking.
let stored: DirHandle | null = null;

export async function restoreClipsDir(): Promise<boolean> {
  try {
    const db = await idb();
    const h = await new Promise<DirHandle | undefined>((res) => {
      const q = db.transaction('h').objectStore('h').get('dir');
      q.onsuccess = () => res(q.result as DirHandle | undefined);
      q.onerror = () => res(undefined);
    });
    if (!h) {return false;}
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') {
      dir = h;
      return true;
    }
    stored = h; // 'prompt' — armable again inside a gesture
  } catch { /* falls through to anchor downloads */ }
  return false;
}

export function hasClipsDir(): boolean { return dir !== null; }

/** Must run inside a user gesture. Returns true when a folder is armed. */
export async function pickClipsDir(): Promise<boolean> {
  // Stored handle awaiting a gesture re-grant? Chrome restores persisted
  // dirs as 'prompt', not 'granted' — without this branch every save
  // silently fell back to the anchor download = a prompt per clip.
  if (!dir && stored) {
    try {
      if ((await stored.requestPermission?.({ mode: 'readwrite' })) === 'granted') {
        dir = stored;
        return true;
      }
    } catch { /* falls through to a fresh pick */ }
    stored = null;
  }
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) {return false;}
  try {
    const h = await picker({ id: 'kribes-clips', mode: 'readwrite' });
    dir = h;
    void persistDir(h);
    return true;
  } catch { return false; } // user cancelled — keep anchor downloads
}

/** Re-grant inside a user gesture when the persisted dir lost permission. */
export async function regrantClipsDir(): Promise<boolean> {
  if (!dir) {return false;}
  try { return (await dir.requestPermission?.({ mode: 'readwrite' })) === 'granted'; }
  catch { return false; }
}

/** Clip vault — silent fallback storage when no folder is armed. Instead
 *  of a prompt-per-clip anchor download, clips land in IDB and export on
 *  demand (a deliberate click is a gesture anyway, so no prompt issue).
 *  Bounded like the ShadowPlay ring: oldest clips evict past the cap. */
const VAULT_MAX = 24;

async function vaultPut(filename: string, blob: Blob): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('v', 'readwrite');
    tx.objectStore('v').put({ name: filename, blob, at: Date.now() }, filename);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  await vaultEvict(db);
}

async function vaultEvict(db: IDBDatabase): Promise<void> {
  const keys = await new Promise<string[]>((res) => {
    const q = db.transaction('v').objectStore('v').getAllKeys();
    q.onsuccess = () => res(q.result as string[]);
    q.onerror = () => res([]);
  });
  if (keys.length <= VAULT_MAX) {return;}
  // Keys are filenames, not insert-ordered — evict by stored timestamp.
  const rows = await new Promise<{ name: string; at: number }[]>((res) => {
    const q = db.transaction('v').objectStore('v').getAll();
    q.onsuccess = () => res(q.result as { name: string; at: number }[]);
    q.onerror = () => res([]);
  });
  rows.sort((a, b) => a.at - b.at);
  for (const r of rows.slice(0, rows.length - VAULT_MAX)) {
    await new Promise<void>((res) => {
      const tx = db.transaction('v', 'readwrite');
      tx.objectStore('v').delete(r.name);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
}

export type VaultClip = { name: string; size: number; at: number };

export async function listClips(): Promise<VaultClip[]> {
  try {
    const db = await idb();
    const rows = await new Promise<{ name: string; blob: Blob; at: number }[]>((res) => {
      const q = db.transaction('v').objectStore('v').getAll();
      q.onsuccess = () => res(q.result as { name: string; blob: Blob; at: number }[]);
      q.onerror = () => res([]);
    });
    return rows.map((r) => ({ name: r.name, size: r.blob.size, at: r.at }))
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/** Deliberate-gesture export — the one place an anchor download is fine. */
export async function exportClip(name: string): Promise<boolean> {
  try {
    const db = await idb();
    const row = await new Promise<{ blob: Blob } | undefined>((res) => {
      const q = db.transaction('v').objectStore('v').get(name);
      q.onsuccess = () => res(q.result as { blob: Blob } | undefined);
      q.onerror = () => res(undefined);
    });
    if (!row) {return false;}
    const url = URL.createObjectURL(row.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch { return false; }
}

export async function deleteClip(name: string): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((res) => {
      const tx = db.transaction('v', 'readwrite');
      tx.objectStore('v').delete(name);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch { /* gone is gone */ }
}

export async function saveClip(filename: string, blob: Blob): Promise<boolean> {
  if (dir) {
    try {
      const fh = await dir.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch { dir = null; } // permission revoked or folder gone — fall through
  }
  // No folder armed → vault it silently (durable, bounded, exportable on
  // demand) instead of the prompt-per-clip anchor path.
  try { await vaultPut(filename, blob); return true; }
  catch {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
}
