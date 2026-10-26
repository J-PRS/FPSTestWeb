/**
 * roompeek — read-only room probe. Joins as a SPECTATOR (no body, no
 * announce), collects gameState + roster events for a few seconds and
 * prints who/what is in the room: player ids, display names, teams,
 * scores, kills. Admin-grade view over a real client socket — no HTTP
 * surface needed.
 *
 *   bun tools/roompeek.ts --url ws://localhost:8000/ws --room headhunt-1
 *   bun tools/roompeek.ts --url wss://play.jprice.app/ws --room headhunt-1 --secs 5
 */
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const normUrl = (u: string): string => {
  if (!u.includes('://')) {u = `wss://${u.includes('.') ? u : `${u}.trycloudflare.com`}`;}
  u = u.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  if (!u.slice(u.indexOf('://') + 3).includes('/')) {u += '/ws';}
  return u;
};
const URL_ = normUrl(arg('url', 'ws://localhost:8000/ws'));
const ROOM = arg('room', 'default');
const SECS = Number.parseFloat(arg('secs', '4'));

interface Seen { id: string; name?: string; team?: string; kills?: number; deaths?: number; spect?: boolean }
const players = new Map<string, Seen>();
const meta: Record<string, unknown> = {};
const scores: Record<string, unknown> = {};
const ffa: [string, number][] = [];

function adoptRow(r: Record<string, unknown>): void {
  const id = r.id as string | undefined;
  if (!id) {return;}
  const s = players.get(id) ?? { id };
  if (typeof r.name === 'string') {s.name = r.name;}
  if (typeof r.team === 'string') {s.team = r.team;}
  players.set(id, s);
}

const ws = new WebSocket(URL_);
const t0 = Date.now();
const fail = (m: string): void => { console.error(`roompeek: ${m}`); process.exit(2); };
setTimeout((): void => fail(`no gameState within ${Math.max(10, SECS * 2)}s — room '${ROOM}' missing or server down`), Math.max(10, SECS * 2) * 1000);

ws.onopen = (): void => {
  ws.send(JSON.stringify({ type: 'join', playerId: `peek-${Math.random().toString(36).slice(2, 8)}`, room: ROOM, spectate: true }));
};
ws.onmessage = (ev): void => {
  if (typeof ev.data !== 'string') {return;} // binary tick frames: the stream exists, we just don't need it
  let m: Record<string, unknown>;
  try { m = JSON.parse(ev.data) as Record<string, unknown>; } catch { return; }
  switch (m.type) {
    case 'gameState': {
      meta.room = m.room ?? ROOM; meta.mode = m.mode; meta.map = m.map;
      for (const p of (m.players as Record<string, unknown>[]) ?? []) {adoptRow(p);}
      Object.assign(meta, { matchEndsAt: m.matchEndsAt, winAt: m.winAt });
      break;
    }
    case 'playerJoined': case 'playerRespawn': {
      adoptRow(m);
      break;
    }
    case 'teamScore': { Object.assign(scores, m.scores as Record<string, unknown>); break;
    }
    case 'ffaScore': { if (typeof m.playerId === 'string') {ffa.push([m.playerId, Number(m.score ?? 0)]);} break;
    }
    case 'sessionRejected': { fail(`sessionRejected: ${m.reason}`); break;
    }
    case 'roomDisposed': { fail(`room disposed: ${m.reason}`); break;
    }
  }
};
ws.onerror = (): void => fail(`socket error on ${URL_}`);
ws.onclose = (e): void => { if (players.size === 0) {fail(`closed ${e.code} ${e.reason}`);} };

setTimeout((): void => {
  try { ws.close(); } catch { /* fine */ }
  const list = [...players.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const humans = list.filter(p => !p.id.startsWith('BOT-') && !p.id.startsWith('NB-'));
  console.log(JSON.stringify({
    room: meta.room ?? ROOM, mode: meta.mode, map: meta.map,
    players: list.length, humans: humans.length,
    scores, ffaTop: ffa.toSorted((a, b) => b[1] - a[1]).slice(0, 5),
    roster: list,
  }, null, 1));
  process.exit(0);
}, SECS * 1000);
