import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step, watch } from './harness.ts';
import type { MapSpec } from '../../../shared/mapSpec.ts';
import { WeaponType } from '../../../shared/weaponTable.ts';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.ts';

// Deployable damage BOTH ways — the siege loop lives on it: emplacements
// deal damage (covered by baseAssets' sentry-bolt test) AND take it from
// real shells. A turret that can't be shelled, a generator a lob can't
// reach through the hull sweep, or a Sticky that doesn't pay its 2x
// breaching mult all fail the raid loop silently.

const TERRAIN_Y = (60 / 255) * 125; // flat harness field

const GEN_SPEC: Partial<MapSpec> = {
  deploys: [{ kind: 'generator', pos: { x: 0, y: TERRAIN_Y, z: 0 }, team: 'alpha' }],
};

const items = (room: ReturnType<typeof mkRoom>, kind: string) =>
  [...room.deployables.items.values()].filter((d) => d.kind === kind);

describe('scenario: deployables take real damage', () => {
  it('a planted field turret drains under splash and deployGones on lethal', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    const p = room.players.getPlayer('p1')!;
    pin(room, 'p1', { x: 20, y: 0, z: 0 });
    p.beltCharges = 10;
    expect(room.deployables.handleDeploy('p1', 'turret', { x: 30, y: 0, z: 0 })).toBe(true);
    const t = items(room, 'turret')[0]!;
    const w = watch(room);

    room.deployables.applyBlast({ x: t.pos.x + 2, y: t.pos.y, z: t.pos.z }, 40, 8, 'raider');
    expect(t.hp).toBeLessThan(DEPLOY_ITEMS.turret.hp);
    // Lethal edge — static gear takes at least half splash inside radius,
    // so a close-in shell always pays something real.
    room.deployables.applyBlast({ x: t.pos.x + 2, y: t.pos.y, z: t.pos.z }, 200, 8, 'raider');
    expect(room.deployables.items.has(t.id)).toBe(false);
    expect(w.count('deployGone')).toBe(1);
  });

  it('a base turret goes DOWN like the gen — hulk, not removal', () => {
    const room = mkRoom({
      deploys: [{ kind: 'baseturret', pos: { x: 0, y: 0, z: 0 }, team: 'alpha' }],
    }, 'ctf');
    const w = watch(room);
    const bt = items(room, 'baseturret')[0]!;
    room.deployables.applyBlast({ x: bt.pos.x + 1, y: bt.pos.y, z: bt.pos.z }, 500, 10, 'raider');
    expect(bt.hp).toBeLessThanOrEqual(0);
    expect(room.deployables.items.has(bt.id)).toBe(true);
    expect(w.count('deployDown')).toBe(1);
    expect(bt.respawnT).toBeGreaterThan(0);
  });

  it('Sticky pays its 2x breaching mult on base assets', () => {
    const room = mkRoom(GEN_SPEC, 'ctf');
    const gen = items(room, 'generator')[0]!;
    room.deployables.applyBlast(gen.pos, 50, 10, 'raider', undefined, WeaponType.Sticky);
    // Contact hit inside bodyR → 50 direct × 2 = 100 paid.
    expect(gen.hp).toBeLessThanOrEqual(400 - 100 + 1);
    expect(gen.hp).toBeGreaterThan(400 - 150); // sanity: not triple-pay
  });

  it('a real grenade lobbed at the gen detonates on its hull and pays splash', () => {
    const room = mkRoom(GEN_SPEC, 'ctf');
    room.players.addPlayer('sieger', 'bravo', 'none', 'medium');
    const gen = items(room, 'generator')[0]!;
    const w = watch(room);
    // Flat point-blank bolt line into the gen's body — the dyn-hull sweep
    // (projContact's solidCols pass) is what makes the shell pop on the
    // target instead of streaking past it.
    room.projectiles.spawn('sieger', WeaponType.Grenade,
      { x: gen.pos.x + 20, y: gen.pos.y + 2, z: gen.pos.z },
      { x: -1, y: 0.05, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 120 && w.count('projectileDestroyed') === 0; i++) {step(room, 1);}
    expect(gen.hp).toBeLessThan(DEPLOY_ITEMS.generator.hp);
  });

  it("the owner's own blast never hurts their gear — only the enemy shells it", () => {
    const room = mkRoom({}, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    room.players.addPlayer('buddy', 'alpha', 'none', 'medium');
    room.players.addPlayer('raider', 'bravo', 'none', 'medium');
    const engi = room.players.getPlayer('engi')!;
    pin(room, 'engi', { x: 20, y: 0, z: 0 });
    engi.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'turret', { x: 30, y: 0, z: 0 })).toBe(true);
    const t = items(room, 'turret')[0]!;
    const at = { x: t.pos.x + 2, y: t.pos.y, z: t.pos.z };
    room.deployables.applyBlast(at, 40, 8, 'engi');  // own mortar: exempt
    expect(t.hp).toBe(DEPLOY_ITEMS.turret.hp);
    room.deployables.applyBlast(at, 40, 8, 'buddy'); // teammate: exempt
    expect(t.hp).toBe(DEPLOY_ITEMS.turret.hp);
    room.deployables.applyBlast(at, 40, 8, 'raider'); // enemy: pays
    expect(t.hp).toBeLessThan(DEPLOY_ITEMS.turret.hp);
  });

  it('a downed generator darkens its team turret — power is the kill reward', () => {
    const room = mkRoom({
      deploys: [
        { kind: 'generator', pos: { x: 0, y: 0, z: 0 }, team: 'alpha' },
        { kind: 'baseturret', pos: { x: 20, y: 0, z: 0 }, team: 'alpha' },
      ],
    }, 'ctf');
    const bt = items(room, 'baseturret')[0]!;
    expect(room.deployables.powered(bt)).toBe(true);
    room.deployables.applyBlast(items(room, 'generator')[0]!.pos, 1000, 10, 'raider');
    expect(room.deployables.teamPowered('alpha')).toBe(false);
    expect(room.deployables.powered(bt)).toBe(false);
  });
});
