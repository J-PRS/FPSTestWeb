import { describe, expect, it } from 'bun:test';
import { mkRoom, firstPlayer, pin, step, watch } from './harness.ts';
import type { MapSpec } from '../../../shared/mapSpec.ts';

// Authored base assets — the Tribes generator economy: spec `deploys`
// seeds live structures at room open; they take blast damage, go DOWN
// (not gone) on death, come back on a long fuse, and a repair tech can
// weld one back early. A dead generator darkens its team's other assets.

const SPEC: Partial<MapSpec> = {
  deploys: [
    { kind: 'generator', pos: { x: -113, y: 0, z: 0 }, team: 'alpha' },
    { kind: 'turret', pos: { x: -90, y: 2, z: -14 }, team: 'alpha' },
    { kind: 'sensor', pos: { x: -100, y: 0, z: 24 }, team: 'alpha' },
    { kind: 'turret', pos: { x: 90, y: 2, z: 14 }, team: 'bravo' },
  ],
};

describe('base assets', () => {
  it('seeds spec deploys with virtual base owners and full hp', () => {
    const room = mkRoom(SPEC, 'ctf');
    const snap = room.deployables.snapshot();
    expect(snap.length).toBe(4);
    const gen = snap.find(d => d.kind === 'generator')!;
    expect(gen.owner).toBe('base:alpha');
    expect(gen.team).toBe('alpha');
    expect(gen.hp).toBe(400);
  });

  it('a shelled generator goes DOWN (not gone), darkens the team turret, and comes back on the fuse', () => {
    const room = mkRoom(SPEC, 'ctf');
    const w = watch(room);
    const gen = [...room.deployables.items.values()].find(d => d.kind === 'generator')!;
    const turret = [...room.deployables.items.values()].find(d => d.kind === 'turret' && d.team === 'alpha')!;
    expect(room.deployables.powered(turret)).toBe(true);

    room.deployables.applyBlast(gen.pos, 1000, 10, 'raider');
    expect(gen.hp).toBeLessThanOrEqual(0);
    expect(gen.respawnT).toBeGreaterThan(0);
    expect(room.deployables.items.has(gen.id)).toBe(true); // hulk, not removed
    expect(w.count('deployDown')).toBe(1);
    expect(w.count('deployGone')).toBe(0);
    expect(room.deployables.powered(turret)).toBe(false); // grid is dark

    step(room, Math.ceil(121 / 0.05)); // ride out the whole respawn fuse
    expect(gen.hp).toBe(400);
    expect(room.deployables.powered(turret)).toBe(true);
    expect(w.count('deployUp')).toBe(1);
  });

  it('a repair tech welds a hulk back up before the fuse', () => {
    const room = mkRoom(SPEC, 'ctf');
    room.players.addPlayer('tech', 'alpha', 'none', 'medium');
    pin(room, 'tech', { x: -110, y: 0, z: 0 });
    const gen = [...room.deployables.items.values()].find(d => d.kind === 'generator')!;
    room.deployables.applyBlast(gen.pos, 1000, 10, 'raider');
    expect(gen.hp).toBeLessThanOrEqual(0);

    const verdict = room.deployables.repair('tech', gen.id);
    expect(verdict).toBe(true);
    expect(gen.hp).toBeGreaterThan(0);   // revived mid-weld, not at the cap
    expect(gen.respawnT).toBe(0);
  });

  it('enemy welders get refused — base assets weld friendly-side only', () => {
    const room = mkRoom(SPEC, 'ctf');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'foe', { x: -110, y: 0, z: 0 });
    const gen = [...room.deployables.items.values()].find(d => d.kind === 'generator')!;
    expect(room.deployables.repair('foe', gen.id)).toBe('enemy');
  });

  it('players cannot plant cap-0 kinds — generators are authored only', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = firstPlayer(room);
    pin(room, 'p1', { x: 0, y: 0, z: 0 });
    p.beltCharges = 10;
    expect(room.deployables.handleDeploy('p1', 'generator', { x: 1, y: 0, z: 0 })).toBe('badkind');
    expect(room.deployables.handleDeploy('p1', 'sensor', { x: 1, y: 0, z: 0 })).toBe('badkind');
    expect(p.beltCharges).toBe(10);
  });

  it('base sentry flies a real bolt — blast lands at the lead point, teammates exempt', () => {
    const room = mkRoom({
      deploys: [{ kind: 'sentry', pos: { x: 0, y: 0, z: 0 }, team: 'alpha' }],
    }, 'ctf');
    const w = watch(room);
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    room.players.addPlayer('ally', 'alpha', 'none', 'medium');
    pin(room, 'foe', { x: 30, y: 0, z: 0 });
    pin(room, 'ally', { x: 32, y: 0, z: 0 }); // inside the bolt's splash too
    const foe = room.players.getPlayer('foe')!;
    const ally = room.players.getPlayer('ally')!;
    const maxFoe = foe.health, maxAlly = ally.health;

    step(room, Math.ceil(1.6 / 0.05));  // fire interval elapses — bolt launches
    expect(w.count('sentryShot')).toBeGreaterThan(0);
    step(room, Math.ceil(0.5 / 0.05));  // ~0.38s flight: the shell lands
    expect(foe.health).toBeLessThan(maxFoe);
    // base:alpha owner is not a player row — the friendly gate must still
    // exempt the sentry's own team or its splash chews defenders.
    expect(ally.health).toBe(maxAlly);
  });

  it('sensor sweeps relay hostiles in radius to its team only', () => {
    const room = mkRoom(SPEC, 'ctf');
    const w = watch(room);
    room.players.addPlayer('ally', 'alpha', 'none', 'medium');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'ally', { x: -100, y: 0, z: 30 });
    pin(room, 'foe', { x: -100, y: 0, z: 40 }); // inside the alpha mast's 120m
    step(room, Math.ceil(2.1 / 0.05));
    expect(w.count('sensorPing')).toBeGreaterThan(0);
    const ping = w.msgs.find(m => m.type === 'sensorPing')!;
    expect((ping as { team?: string }).team).toBe('alpha');
    expect((ping as { targets: { id: string }[] }).targets.some(t => t.id === 'foe')).toBe(true);
    expect((ping as { targets: { id: string }[] }).targets.some(t => t.id === 'ally')).toBe(false);
  });
});
