// Last-room memory — on F5 the client boots straight into the map it was
// just playing instead of spending the connect round-trip on the default
// field it will throw away ~2s later. The server's gameState still
// overwrites everything when it lands; this only wins the first seconds.

import type { MapSnapshot } from './world.js';

const KEY = 'fps-last-room-map';

interface SavedRoomMap { host: string; map: MapSnapshot }

export function saveLastRoomMap(host: string, map: MapSnapshot | undefined): void {
  if (!map || Object.keys(map).length === 0) {return;}
  try { localStorage.setItem(KEY, JSON.stringify({ host, map } satisfies SavedRoomMap)); }
  catch { /* quota/private mode — the next boot just falls back */ }
}

/** Only reused on the same host — a different server gets a clean boot. */
export function loadLastRoomMap(host: string): MapSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {return null;}
    const v = JSON.parse(raw) as SavedRoomMap;
    return v?.host === host && v.map && typeof v.map === 'object' ? v.map : null;
  } catch { return null; }
}

/** Cheap liveness gate: any completed HTTP response proves the host is
 *  up (a 404 still answers). Only the saved map rides on this — the real
 *  connect attempt happens either way. */
export async function pingServer(httpUrl: string, timeoutMs = 1200): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout((): void => ac.abort(), timeoutMs);
    try { await fetch(`${httpUrl}/rooms`, { signal: ac.signal, cache: 'no-cache' }); }
    finally { clearTimeout(t); }
    return true;
  } catch { return false; }
}
