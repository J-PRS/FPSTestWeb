/** Wire byte accounting — cumulative per-connection + global totals.
 *  The probe diffs two reads; no rate machinery lives here. Hooks sit
 *  at the three send chokes (reliable, tick-binary, ball-binary) and at
 *  GameServer.onMessage for inbound. */

interface ConnBytes { rxB: number; rxF: number; txB: number; txF: number }
const conns = new Map<string, ConnBytes>();
const total: ConnBytes = { rxB: 0, rxF: 0, txB: 0, txF: 0 };
const startedAt = Date.now();

function slot(pid: string): ConnBytes {
  let s = conns.get(pid);
  if (!s) {s = { rxB: 0, rxF: 0, txB: 0, txF: 0 }; conns.set(pid, s);}
  return s;
}

export function wireRx(pid: string | undefined, bytes: number): void {
  total.rxB += bytes; total.rxF += 1;
  const s = slot(pid ?? '');
  s.rxB += bytes; s.rxF += 1;
}

export function wireTx(pid: string, bytes: number): void {
  total.txB += bytes; total.txF += 1;
  const s = slot(pid);
  s.txB += bytes; s.txF += 1;
}

export function wireMeterSnapshot(): { at: number; uptimeS: number; total: ConnBytes; conns: Record<string, ConnBytes> } {
  return {
    at: Date.now(), uptimeS: Math.round((Date.now() - startedAt) / 1000),
    total,
    conns: Object.fromEntries(conns),
  };
}
