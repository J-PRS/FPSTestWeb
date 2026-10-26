/** Wire byte accounting — cumulative per-connection + global totals.
 *  The probe diffs two reads; no rate machinery lives here. Hooks sit
 *  at the three send chokes (reliable, tick-binary, ball-binary) and at
 *  GameServer.onMessage for inbound. */

interface ConnBytes { rxB: number; rxF: number; txB: number; txF: number }
const conns = new Map<string, ConnBytes>();
const total: ConnBytes = { rxB: 0, rxF: 0, txB: 0, txF: 0 };
const txByKind = new Map<string, { b: number; f: number }>();
const rxByKind = new Map<string, { b: number; f: number }>();
const startedAt = Date.now();

function slot(pid: string): ConnBytes {
  let s = conns.get(pid);
  if (!s) {s = { rxB: 0, rxF: 0, txB: 0, txF: 0 }; conns.set(pid, s);}
  return s;
}

/** Precomputed `bin:N` metering tags — a template literal per send was
 *  ~25K string allocs/s of pure bookkeeping churn. */
export const BIN_KIND: readonly string[] = Array.from({ length: 256 }, (_, i) => `bin:${i}`);

export function wireRx(pid: string | undefined, bytes: number, kind?: string): void {
  total.rxB += bytes; total.rxF += 1;
  const s = slot(pid ?? '');
  s.rxB += bytes; s.rxF += 1;
  if (kind !== undefined) {
    const k = rxByKind.get(kind) ?? { b: 0, f: 0 };
    k.b += bytes; k.f += 1; rxByKind.set(kind, k);
  }
}

export function wireTx(pid: string, bytes: number, kind?: string): void {
  total.txB += bytes; total.txF += 1;
  const s = slot(pid);
  s.txB += bytes; s.txF += 1;
  if (kind !== undefined) {
    const k = txByKind.get(kind) ?? { b: 0, f: 0 };
    k.b += bytes; k.f += 1; txByKind.set(kind, k);
  }
}

/** Seat closed — drop its cumulative entry so /wire lists live conns,
 *  not every id that ever connected. Totals stay cumulative by design. */
export function wireClose(pid: string): void { conns.delete(pid); }

export function wireMeterSnapshot(nameOf?: (pid: string) => string | undefined): { at: number; uptimeS: number; total: ConnBytes; conns: Record<string, ConnBytes & { name?: string }>; txByKind: Record<string, { b: number; f: number }>; rxByKind: Record<string, { b: number; f: number }> } {
  return {
    at: Date.now(), uptimeS: Math.round((Date.now() - startedAt) / 1000),
    total,
    conns: nameOf
      ? Object.fromEntries([...conns].map(([pid, s]) => [pid, Object.assign({}, s, { name: nameOf(pid) })]))
      : Object.fromEntries(conns),
    txByKind: Object.fromEntries(txByKind),
    rxByKind: Object.fromEntries(rxByKind),
  };
}
