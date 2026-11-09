import { wallMs } from '../src/wallClock.ts';
import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { getWeaponStats } from '../../shared/weapons.ts';
import { PERK_ORDER } from '../../shared/perks.ts';
import { BOT_NAMES } from '../../shared/botNames.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// A real field turns on the MoveSim path — bots then integrate through the
// same physics + energy economy as human shadows instead of direct writes.
const flat: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };

// ServerBots needs a Room for players/messages/assignTeam — a plain Room
// (no field, no sockets) is enough: broadcasts just hit zero recipients.

describe('ServerBots', () => {
  it('populates N bots as roster entries', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 4 }));
    expect(room.bots.count).toBe(4);
    expect(room.players.getPlayerCount()).toBe(4);
    expect(room.players.getPlayer('BOT-VEKTOR-01')?.isBot).toBe(true);
  });

  it('balances bots across teams in team modes', () => {
    const room = new Room('t', null, '', resolveMapSpec({ mode: 'nuggets', bots: 6 }));
    const teams = { alpha: 0, bravo: 0 };
    for (const p of room.players.getAllPlayers().values()) {
      if (p.team) {teams[p.team]++;}
    }
    expect(teams.alpha).toBe(3);
    expect(teams.bravo).toBe(3);
  });

  it('does not count bots toward room emptiness', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 3 }));
    expect(room.empty).toBe(true); // bots alone don't keep a match alive
  });

  it('humans keep the room alive alongside bots', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 3 }));
    room.players.addPlayer('human');
    expect(room.empty).toBe(false);
  });

  it('moves bots toward waypoints on tick', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-VEKTOR-01')!;
    const before = { ...p.position };
    for (let i = 0; i < 20; i++) {room.bots.tick(0.05);}
    const moved = Math.hypot(p.position.x - before.x, p.position.z - before.z);
    expect(moved).toBeGreaterThan(1);
    expect(p.lastSeq).toBeGreaterThan(0);
  });

  it('heartbeats lastSeen so the idle reaper skips socketless bots', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-VEKTOR-01')!;
    p.lastSeen = wallMs(0);
    room.bots.tick(0.05);
    expect(p.lastSeen).toBeGreaterThan(0);
  });

  it('untrack stops ticking a removed bot', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    room.bots.untrack('BOT-VEKTOR-01');
    const p = room.players.getPlayer('BOT-VEKTOR-01')!;
    const before = { ...p.position };
    room.bots.tick(0.05);
    expect(p.position).toEqual(before);
    expect(room.bots.count).toBe(0);
  });

  it('dead bots stop moving and firing', () => {
    const room = new Room('t', null, '', resolveMapSpec({ bots: 1 }));
    const p = room.players.getPlayer('BOT-VEKTOR-01')!;
    p.isDead = true;
    const before = { ...p.position };
    const seq = p.lastSeq;
    room.bots.tick(0.05);
    expect(p.position).toEqual(before);
    expect(p.lastSeq).toBe(seq);
  });

  it('bots integrate through the move shadow when a field is attached', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1 }));
    const id = 'BOT-VEKTOR-01';
    expect(room.moveSim.simState(id)).not.toBeNull();
    const p = room.players.getPlayer(id)!;
    const before = { ...p.position };
    // Room ticks sims in order: bots set inputs, then moveSim steps them.
    for (let i = 0; i < 40; i++) { room.bots.tick(0.05); room.moveSim.tick(0.05); }
    const moved = Math.hypot(p.position.x - before.x, p.position.z - before.z);
    expect(moved).toBeGreaterThan(1);
    // The commit path writes the sim's velocity, not a synthetic hop.
    expect(Math.hypot(p.velocity.x, p.velocity.z)).toBeGreaterThan(0);
  });

  it('skill intents drain the shadow tank like a human claim', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1, mode: 'dm' }));
    const p = room.players.getPlayer('BOT-VEKTOR-01')!;
    p.health = 10; // hurt — the brain picks mend/shield, and the sim charges it
    const full = room.moveSim.energyOf('BOT-VEKTOR-01')!;
    for (let i = 0; i < 40; i++) { room.bots.tick(0.05); room.moveSim.tick(0.05); }
    expect(room.moveSim.energyOf('BOT-VEKTOR-01')!).toBeLessThan(full);
  });

  it('assigns each bot a loadout perk at spawn', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 4, mode: 'dm' }));
    // rollBotPerk draws the full PERK_ORDER table (kitConsistent-filtered)
    // - the pool grows with every new perk, so assert legality not a list.
    for (let i = 1; i <= 4; i++) {
      const p = room.players.getPlayer(`BOT-${BOT_NAMES[i - 1]}-0${i}`)!;
      expect(PERK_ORDER as readonly string[]).toContain(p.perk);
      // assert the perk reached both the roster and the move shadow.
      expect(room.moveSim.simState(p.id)).not.toBeNull();
    }
  });

  it('range-band select only spawns ballistic weapons', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1, mode: 'dm' }));
    room.players.addPlayer('human').position = { x: 21, y: 0, z: 0 };
    const msgs: { type: string; weaponType?: number }[] = [];
    room.broadcast = (m: never) => { msgs.push(m); };
    const bot = room.players.getPlayer('BOT-VEKTOR-01')!;
    bot.position = { x: -21, y: 0, z: 0 }; // 42m — inside sight, far band
    for (let i = 0; i < 80; i++) { room.bots.tick(0.05); room.moveSim.tick(0.05); }
    // Guard against a vacuous run — the bot must have fired at all.
    expect(msgs.some(m => m.type === 'projectileCreated' || m.type === 'playerShot')).toBe(true);
    for (const m of msgs.filter(mm => mm.type === 'projectileCreated')) {
      // Anything that spawned must be a real ballistic weapon — hitscan
      // (speed 0, e.g. near-band Chaingun) never reaches this broadcast.
      expect(getWeaponStats(m.weaponType!).speed).toBeGreaterThan(0);
    }
  });

  it('respawning a bot reseats the shadow at the new position', () => {
    const room = new Room('t', flat, '', resolveMapSpec({ bots: 1 }));
    const id = 'BOT-VEKTOR-01';
    const p = room.players.getPlayer(id)!;
    p.isDead = true;
    room.bots.tick(0.05); // marks the bot in deadSet
    // Room respawns the body somewhere new.
    p.isDead = false;
    p.position = { x: 300, y: 30, z: -200 };
    room.bots.tick(0.05);
    const sh = room.moveSim.simState(id)!;
    expect(Math.hypot(sh.pos.x - 300, sh.pos.z + 200)).toBeLessThan(30);
  });

  it('CTF: bots intercept the thief and escort their own carrier', () => {
    const room = new Room('t', null, '', resolveMapSpec({
      mode: 'ctf', bots: 4,
      bases: { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } },
    }));
    expect(room.flags).not.toBeNull();
    const flagGoal = (p: { id: string; team?: string; position: { x: number; y: number; z: number } }) =>
      (room.bots as unknown as { flagGoal: (q: unknown) => { pos: { x: number; z: number } } | null }).flagGoal(p)?.pos;
    const bots = [...(room.bots as unknown as { brains: Map<string, unknown> }).brains.keys()]
      .map((id) => room.players.getPlayer(id)!);
    const roles = (room.bots as unknown as { roster: { roleInfo: Map<string, string> } }).roster.roleInfo;
    const carrier = bots.find((b) => b.team === 'alpha')!;
    // An offense teammate escorts; a plated defender holds the stand.
    const escort = bots.find((b) => b.team === 'alpha' && b !== carrier)!;
    const defender = bots.find((b) => b.team === 'bravo')!;
    if (escort) {roles.set(escort.id, 'offense');} // deterministic role for the assert

    // Alpha bot grabs bravo's flag — park it on the enemy stand.
    carrier.position = { x: 70, y: 0, z: 0 };
    room.tickFlags(0.05);
    expect(room.flags!.flags.get('bravo')!.carrier).toBe(carrier.id);

    // Carrier's own goal is its home base.
    expect(flagGoal(carrier)).toMatchObject({ x: -70, z: 0 });
    // Teammate escorts the carrier, not the now-empty enemy stand.
    expect(flagGoal(escort)).toMatchObject({ x: 70, z: 0 });
    // Bravo bot intercepts the carrier's live position, not its own base.
    expect(flagGoal(defender)).toMatchObject({ x: 70, z: 0 });

    // Carrier moves — the pursuit tracks the live position.
    carrier.position = { x: 10, y: 0, z: 5 };
    expect(flagGoal(defender)).toMatchObject({ x: 10, z: 5 });

    // With no flags in play, a plated defender holds its own stand.
    for (const f of room.flags!.flags.values()) {
      f.state = 'home'; f.carrier = null; f.pos = { ...f.home };
    }
    const anchor = bots.find((b) => roles.get(b.id) === 'defense');
    if (anchor) {
      const {home} = room.flags!.flags.get(anchor.team as 'alpha' | 'bravo')!;
      expect(flagGoal(anchor)).toMatchObject({ x: home.x, z: home.z });
    }
  });
});
