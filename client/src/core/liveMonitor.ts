// Live invariant monitor — opt-in via ?monitor=1. Records violations of
// netcode invariants while you play; never changes gameplay. Read the
// console for `[MONITOR]` lines or call window.__monitor.dump() for the ring.

const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('monitor') === '1';
const RING = 200;
const ring: { t: number; kind: string; detail: Record<string, unknown> }[] = [];
const counts: Record<string, number> = {};

export function monitorOn(): boolean { return enabled; }

export function violation(kind: string, detail: Record<string, unknown>): void {
  if (!enabled) {return;}
  counts[kind] = (counts[kind] ?? 0) + 1;
  ring.push({ t: Math.round(performance.now()), kind, detail });
  if (ring.length > RING) {ring.splice(0, ring.length - RING);}
  console.warn(`[MONITOR] ${kind} ${JSON.stringify(detail)}`);
}

// Same shot id hitting the same victim more than once inside the window.
// Multi-pellet weapons may legitimately repeat — the log keeps the weapon
// id so the report can tell them apart.
const hitSeen = new Map<string, number>();
const DUP_WINDOW_MS = 250;
export function checkHit(shotId: string | undefined, victim: string, seq: number | undefined, damage: number): void {
  if (!enabled || !shotId) {return;}
  const now = performance.now();
  const key = `${shotId}|${victim}`;
  const prev = hitSeen.get(key);
  if (prev !== undefined && now - prev < DUP_WINDOW_MS) {
    violation('dup-hit', { shot: shotId, victim, seq: seq ?? '?', dmg: damage, dtMs: Math.round(now - prev) });
  }
  hitSeen.set(key, now);
  if (hitSeen.size > 256) {for (const [k, t] of hitSeen) {if (now - t > DUP_WINDOW_MS * 4) {hitSeen.delete(k);}}}
}

export function monitorDump(): { counts: Record<string, number>; ring: typeof ring } {
  return { counts: Object.assign({}, counts), ring: ring.slice() };
}

if (enabled && typeof window !== 'undefined') {
  (window as unknown as { __monitor: unknown }).__monitor = { dump: monitorDump };
}
