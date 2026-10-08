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
  const r = indexedDB.open('kribes-clips', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('h');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function persistDir(h: DirHandle): Promise<void> {
  try {
    const db = await idb();
    db.transaction('h', 'readwrite').objectStore('h').put(h, 'dir');
  } catch { /* persistence is a nicety, not a requirement */ }
}

export async function restoreClipsDir(): Promise<boolean> {
  try {
    const db = await idb();
    const h = await new Promise<DirHandle | undefined>((res) => {
      const q = db.transaction('h').objectStore('h').get('dir');
      q.onsuccess = () => res(q.result as DirHandle | undefined);
      q.onerror = () => res(undefined);
    });
    if (h && (await h.queryPermission?.({ mode: 'readwrite' }) === 'granted')) {
      dir = h;
      return true;
    }
  } catch { /* falls through to anchor downloads */ }
  return false;
}

export function hasClipsDir(): boolean { return dir !== null; }

/** Must run inside a user gesture. Returns true when a folder is armed. */
export async function pickClipsDir(): Promise<boolean> {
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
