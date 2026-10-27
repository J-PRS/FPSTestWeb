// Park probe — spectator join, decode binary tick stream, measure
// per-bot XZ displacement over the window. Standing bots = ~0m.
import { decodeTickFrame, iterBatch } from '../../shared/wire.ts';

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const URL_ = arg('url', 'wss://play.jprice.app/ws');
const ROOM = arg('room', 'headhunt-1');
const SECS = Number(arg('secs', '20'));

const wireIds = new Map<number, string>();
const tickPool = { slots: [] as never[], byId: new Map<number, never>(), resolveId: (id: number) => wireIds.get(id) };
const pos = new Map<string, { x: number; y: number; z: number }>();
const first = new Map<string, { x: number; y: number; z: number }>();
const dead = new Set<string>();
let frames = 0, decN = 0;

const ws = new WebSocket(URL_);
ws.onopen = (): void => { ws.send(JSON.stringify({ type: 'join', playerId: `park-${Math.random().toString(36).slice(2, 8)}`, room: ROOM })); };
ws.onmessage = (ev): void => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.type === 'gameState' && m.wireIds) {for (const [id, pid] of Object.entries(m.wireIds)) {wireIds.set(Number(id), pid as string);}}
    if (m.type === 'wireIds') {
      for (const [id, pid] of Object.entries(m.add ?? {})) {wireIds.set(Number(id), pid as string);}
      for (const id of (m.remove ?? [])) {wireIds.delete(id);}
    }
    return;
  }
  (ev.data as Blob).arrayBuffer?.().then((ab) => {
    let subs = 0, dec = 0;
    for (const u8 of iterBatch(new Uint8Array(ab))) {
      subs++;
      const f = decodeTickFrame(u8, tickPool as never);
      if (!f) {continue;}
      dec++;
      for (let i = 0; i < f.count; i++) {
        const u = f.updates[i]!;
        if (!u.playerId) {continue;}
        if (u.isDead) {dead.add(u.playerId);} else {dead.delete(u.playerId);}
        pos.set(u.playerId, u.position);
        if (!first.has(u.playerId)) {first.set(u.playerId, { ...u.position });}
      }
    }
  }).catch(() => {});
};

setTimeout((): void => {
  const rows = [...pos.entries()].map(([id, p]) => {
    const f0 = first.get(id)!;
    return { id, d: Math.hypot(p.x - f0.x, p.y - f0.y, p.z - f0.z), dead: dead.has(id) };
  }).sort((a, b) => a.d - b.d);
  console.log(`frames=${frames} decoded=${decN}`); console.log(`park probe ${ROOM} ${SECS}s — ${rows.length} bodies seen`);
  for (const r of rows) {console.log(`  ${r.id.padEnd(20)} ${r.d.toFixed(1).padStart(7)}m${r.dead ? ' (dead now)' : ''}`);}
  process.exit(0);
}, SECS * 1000);
