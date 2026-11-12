import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DEMO_SPECIES, DEMO_DEPLOY_KINDS, DEMO_PICKUP_KINDS } from '../../client/src/demo/types.ts';
import { SPECIES } from '../../shared/species.ts';
import { DEPLOY_ITEMS } from '../../shared/deployItems.ts';

/**
 * Demo coverage registry — the "is anything not recorded?" tripwire.
 *
 * Every ServerMessage wire type and every creature/deployable/pickup
 * kind is either RECORDED (a demo lane owns it) or EXEMPT with a reason.
 * Adding a new wire type, species, deploy kind or pickup kind without a
 * recording lane fails this test — the failure IS the warning JP asked
 * for: nothing live goes unrecorded silently.
 */

const protocol = readFileSync(new URL('../../shared/protocol.ts', import.meta.url), 'utf8');
const serverBlock = protocol.slice(protocol.indexOf('export type ServerMessage'));
const SERVER_TYPES = [...serverBlock.matchAll(/\{ type: '(\w+)'/g)].map(m => m[1]!);

// wire type -> recording lane (documented: see client/src/demo/demoEvents.ts)
const RECORDED: Record<string, string> = {
  ballSpawn: 'ball targets', ballSegment: 'ball targets', ballDie: 'ball targets', ballRoster: 'ball targets',
  crawlSpawn: 'creatures', crawlEvt: 'creatures', crawlDie: 'creatures', crawlRoster: 'creatures',
  deploySpawn: 'deployables', deployGone: 'deployables', deployDown: 'deployables',
  deployUp: 'deployables', deployHp: 'deployables',
  turretShot: 'deployables', sentryShot: 'deployables', mineBoom: 'deployables', mortarShot: 'deployables',
  flagUpdate: 'flags',
  // Signed match receipt — the demo trailer owns it (DemoRecorder.matchToken
  // → demoWriter/demoReader), so leaderboard submissions can pair clip+token.
  matchToken: 'match receipt (demo trailer)',
  pickupSpawn: 'pickups', pickupGone: 'pickups',
  playerKill: 'kills',
  projectileCreated: 'remote projectiles', projectileDestroyed: 'remote projectiles',
  snapshot: 'remote frames', tickUpdate: 'remote frames',
  playerJoined: 'remote frames', playerLeft: 'remote frames',
  playerRespawn: 'remote frames', teleport: 'remote frames',
};

// wire type -> why it is intentionally not recorded. An unclassed new type
// fails below until it lands in one of these maps.
const EXEMPT: Record<string, string> = {
  gameState: 'join snapshot — roster adoption covers its actors',
  // Conquest lattice — no demo lane yet (mode pilot); flagged exempt so a
  // future lane removal can't silently orphan the type.
  nodeUpdate: 'conquest pilot — demo lane lands with the mode, not before',
  mapUpdate: 'terrain is excluded from demos by design (action only)',
  chat: 'comms are not action',
  matchNotice: 'meta text, not an actor',
  matchStart: 'match meta — room/mode already ride the header',
  matchEnd: 'match meta',
  teamScore: 'score meta — not a body on the field',
  ffaScore: 'score meta',
  ffaMatchEnd: 'score meta',
  teamUpdate: 'roster meta',
  classUpdate: 'roster meta',
  perkUpdate: 'roster meta',
  playerHeld: 'roster meta — headhunt crown/count are cosmetic reads',
  weaponUpdate: 'roster meta — held-gun silhouette is a cosmetic read',
  playerStale: 'roster meta — ghost shimmer is a cosmetic read; remote frames own the body',
  gunRung: 'roster meta — gungame ladder position is UI/loadout state, not an actor',
  buff: 'local-state echo — local frames own hp/armor',
  yourHealth: 'local-state echo',
  yourCharge: 'local-state echo',
  yourAmmo: 'local-state echo',
  playerShot: 'hitscan cosmetic relay — no actor persists',
  playerHit: 'hit feedback — remote frames carry the damage result',
  jump: 'remote anim relay — remote frames already carry pos/flags',
  landed: 'remote anim/FX relay — slam thud + dust, remote frames carry the landing',
  jetpack: 'remote anim relay',
  knockback: 'impulse echo — remote frames carry the result',
  padBoing: 'launch FX relay — remote frames carry the resulting velocity',
  loiterDive: 'dive FX relay — the blast arrives through the mineBoom funnel',
  projRide: 'cosmetic pairing relay — destroy events carry the contact pos',
  srvPing: 'liveness',
  aoeShot: 'cosmetic beam relay',
  sensorPing: 'intel relay — no actor state',
  intel: 'per-player IFF feed — marker visibility is UI state, not an actor',
  correction: 'self-sync control traffic',
  inputSync: 'control traffic',
  claimAck: 'control traffic',
  claimDropped: 'control traffic',
  shotRejected: 'control traffic',
  serverWarn: 'control traffic',
  sessionRejected: 'control traffic',
  switchRoom: 'control traffic',
  wireIds: 'control traffic',
  pong: 'liveness',
  ping: 'liveness',
  resync: 'control traffic',
  stateHash: 'control traffic',
  respawn: 'covered by remote frames (pos resets on spawn)',
};

describe('demo coverage registry', () => {
  it('every ServerMessage type is recorded or explicitly exempt', () => {
    const unclassified = SERVER_TYPES.filter(t => !(t in RECORDED) && !(t in EXEMPT));
    expect(unclassified).toEqual([]);
  });

  it('recorded lanes reference real wire types (no stale names)', () => {
    const stale = Object.keys(RECORDED).filter(t => !SERVER_TYPES.includes(t));
    expect(stale).toEqual([]);
  });

  it('every species has a demo lane index, in registry order', () => {
    expect(DEMO_SPECIES as readonly string[]).toEqual(Object.keys(SPECIES));
  });

  it('every deploy kind has a demo lane index, in registry order', () => {
    expect(DEMO_DEPLOY_KINDS as readonly string[]).toEqual(Object.keys(DEPLOY_ITEMS));
  });

  it('every pickup kind has a demo lane index', () => {
    const pickups = readFileSync(new URL('../../shared/pickups.ts', import.meta.url), 'utf8');
    const m = pickups.match(/type PickupKind = ([^;]+)/);
    const kinds = m ? [...m[1]!.matchAll(/'(\w+)'/g)].map(x => x[1]!) : [];
    expect(DEMO_PICKUP_KINDS as readonly string[]).toEqual(kinds);
  });
});
