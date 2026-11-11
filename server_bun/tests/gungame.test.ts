import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { gunGameWeapon, gunGameAllows, igunChassis, gunGameClimax } from '../../shared/gunGame.ts';
import { roomDirectDamage, WeaponType } from '../../shared/weapons.ts';
import { roomModsOf } from '../../shared/protocol.ts';
import type { RoomMods, ServerMessage } from '../../shared/protocol.ts';

const DM_SPEC = resolveMapSpec({ mode: 'dm' });

function ggRoom(sent: ServerMessage[], igun = false) {
  const room = new Room('t', null, '', DM_SPEC);
  room.mods.gungame = true;
  if (igun) {room.mods.igun = true;}
  room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
  return room;
}

function combatOf(room: Room) {
  return (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void; handleEnvironmentDamage(p: string, m: { type: 'environmentDamage'; damage: number }): void } }).combat;
}

/** Drive botAttack until the victim dies (or the cap hits) - the same
 *  funnel dmscore uses; returns whether the kill landed. */
function fightUntilDead(room: Room, shooter: string, victim: string, weapon: number, cap = 80): boolean {
  const c = combatOf(room);
  for (let i = 0; i < cap && !room.players.getPlayer(victim)!.isDead; i++) {c.botAttack(shooter, victim, weapon);}
  return room.players.getPlayer(victim)!.isDead;
}

describe('gun game rules', () => {
  it('roomModsOf normalizes igun -> gungame', () => {
    expect(roomModsOf({ igun: true }).gungame).toBe(true);
    expect(roomModsOf({ igun: true }).igun).toBe(true);
    expect(roomModsOf({ gungame: true }).igun).toBeFalsy();
    expect(roomModsOf(undefined).gungame).toBeFalsy();
  });

  it('ladder gate: rung weapon + hook only', () => {
    const w0 = gunGameWeapon(0);
    expect(gunGameAllows(0, w0)).toBe(true);
    expect(gunGameAllows(0, WeaponType.Hook)).toBe(true);
    expect(gunGameAllows(0, WeaponType.Railgun)).toBe(w0 === WeaponType.Railgun);
    expect(gunGameAllows(gunGameClimax(), gunGameWeapon(gunGameClimax()))).toBe(true);
    expect(gunGameAllows(gunGameClimax(), WeaponType.Melee)).toBe(false);
    expect(gunGameAllows(gunGameClimax() + 5, gunGameWeapon(gunGameClimax()))).toBe(true); // clamps
  });

  it('igun pays table direct ×10; classic pays table damage', () => {
    for (const wt of [WeaponType.PlasmaGun, WeaponType.Railgun, WeaponType.Howitzer]) {
      const table = roomDirectDamage(wt, false);
      expect(roomDirectDamage(wt, false, undefined, true)).toBe(table * 10);
      expect(table).toBeGreaterThan(0);
    }
    // instagib still only overrides the railgun.
    expect(roomDirectDamage(WeaponType.Chaingun, true)).not.toBe(200);
    expect(roomDirectDamage(WeaponType.Railgun, true)).toBe(200);
  });

  it('kill advances the shooter one rung and resets the victim', () => {
    const sent: ServerMessage[] = [];
    const room = ggRoom(sent);
    room.players.addPlayer('shooter');
    room.players.addPlayer('victim');
    room.players.breakShield('victim');
    room.players.breakShield('shooter');

    const w0 = gunGameWeapon(0);
    expect(room.gunRungOf('shooter')).toBe(0);
    expect(room.gunGameAllowsFire('shooter', w0)).toBe(true);
    expect(room.gunGameAllowsFire('shooter', WeaponType.Railgun)).toBe(false);

    expect(fightUntilDead(room, 'shooter', 'victim', w0)).toBe(true);
    expect(room.gunRungOf('shooter')).toBe(1);
    expect(room.gunRungOf('victim')).toBe(0);
    // Roster weapon follows the rung - a rolled member of the new bucket.
    expect(gunGameAllows(1, room.players.getPlayer('shooter')!.weapon ?? -1)).toBe(true);
  });

  it('off-ladder weapons deal no damage through the bot attack funnel', () => {
    const sent: ServerMessage[] = [];
    const room = ggRoom(sent);
    room.players.addPlayer('shooter');
    room.players.addPlayer('victim');
    room.players.breakShield('victim');
    room.players.breakShield('shooter');

    const hp = room.players.getPlayer('victim')!.health;
    // Railgun is deep in the ladder - rung 0 can't touch it.
    for (let i = 0; i < 10; i++) {combatOf(room).botAttack('shooter', 'victim', WeaponType.Railgun);}
    expect(room.players.getPlayer('victim')!.health).toBe(hp);
    expect(room.players.getPlayer('victim')!.isDead).toBe(false);
    // Melee can't punch either - the ladder owns every damage path.
    for (let i = 0; i < 40; i++) {combatOf(room).botAttack('shooter', 'victim', WeaponType.Melee);}
    expect(room.players.getPlayer('victim')!.isDead).toBe(false);
  });

  it('environment kills reset the victim but advance nobody', () => {
    const sent: ServerMessage[] = [];
    const room = ggRoom(sent);
    room.players.addPlayer('victim');
    room.players.addPlayer('bystander');
    room.players.breakShield('victim');
    // Fake a climbed rung, then die to the wilderness.
    (room as unknown as { setGunRung(id: string, r: number): void }).setGunRung('victim', 5);
    (room as unknown as { setGunRung(id: string, r: number): void }).setGunRung('bystander', 3);
    for (let i = 0; i < 40 && !room.players.getPlayer('victim')!.isDead; i++) {combatOf(room).handleEnvironmentDamage('victim', { type: 'environmentDamage', amount: 9999 } as never);}
    expect(room.players.getPlayer('victim')!.isDead).toBe(true);
    expect(room.gunRungOf('victim')).toBe(0);
    expect(room.gunRungOf('bystander')).toBe(3);
  });

  it('climax holds - kills past the top rung stay on top', () => {
    const sent: ServerMessage[] = [];
    const room = ggRoom(sent);
    room.players.addPlayer('shooter');
    room.players.addPlayer('victim');
    (room as unknown as { setGunRung(id: string, r: number): void }).setGunRung('shooter', gunGameClimax());
    room.players.breakShield('victim');
    room.players.breakShield('shooter');
    expect(fightUntilDead(room, 'shooter', 'victim', room.players.getPlayer('shooter')!.weapon ?? -1)).toBe(true);
    expect(room.gunRungOf('shooter')).toBe(gunGameClimax());
    expect(room.gunRungOf('victim')).toBe(0);
  });

  it('igun chassis follows the rung weapon tier - light/heavy swaps land live', () => {
    const sent: ServerMessage[] = [];
    const room = ggRoom(sent, true);
    room.players.addPlayer('p1', undefined, 'none', 'heavy');
    room.gunGameSeat('p1');
    const p = room.players.getPlayer('p1')!;
    // Rung 0 bucket (FastDisc + BoltLauncher) is untiered -> medium chassis.
    expect(p.armorClass).toBe(igunChassis(p.weapon));
    // Advance to a tiered rung -> chassis follows the rolled weapon's tier.
    (room as unknown as { setGunRung(id: string, r: number): void }).setGunRung('p1', 1);
    expect(p.armorClass).toBe(igunChassis(p.weapon));
    // Death drops back to rung 0 -> medium again.
    (room as unknown as { setGunRung(id: string, r: number): void }).setGunRung('p1', 0);
    expect(p.armorClass).toBe(igunChassis(p.weapon));
    // Stale claims can't stick a different class - igun derives it.
    room.applyClaimedClass('p1', 'heavy');
    expect(p.armorClass).toBe(igunChassis(p.weapon));
    // Classic gungame keeps the player's class pick.
    const classic = ggRoom([]);
    classic.players.addPlayer('p2', undefined, 'none', 'light');
    classic.gunGameSeat('p2');
    expect(classic.players.getPlayer('p2')!.armorClass).toBe('light');
  });

  it('non-gungame rooms ignore the ladder entirely', () => {
    const sent: ServerMessage[] = [];
    const room = new Room('t', null, '', DM_SPEC);
    room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
    room.players.addPlayer('shooter');
    room.players.addPlayer('victim');
    room.players.breakShield('victim');
    room.players.breakShield('shooter');
    expect(fightUntilDead(room, 'shooter', 'victim', WeaponType.Railgun)).toBe(true);
    expect(room.gunRungOf('shooter')).toBe(0);
  });
});

describe('gun game AOE weapon gates', () => {
  /** CombatHandler with injectable kit mods - the same deps Room wires. */
  function aoeHarness(mods: RoomMods, rung: number) {
    const players = new PlayerManager();
    const sentTo: { id: string; msg: ServerMessage }[] = [];
    const combat = new CombatHandler(players, () => {},
      (id, msg) => sentTo.push({ id, msg }),
      { mods: () => mods, gunRungOf: () => rung });
    return { players, combat, sentTo };
  }
  const rejects = (sentTo: { id: string; msg: ServerMessage }[]) =>
    sentTo.filter((m) => m.msg.type === 'shotRejected')
      .map((m) => (m.msg as { reason?: string }).reason ?? '');

  it('the kit gate replaces the class lock - a light player fires the heavy-tier rung weapon', () => {
    const { players, combat, sentTo } = aoeHarness({ gungame: true }, 0);
    const p = players.addPlayer('p1', undefined, 'none', 'light');
    p.position = { x: 0, y: 10, z: 0 };
    // Rung 0 is Howitzer (heavy tier) - classCanFire would refuse it
    // for a light, but the ladder owns admission in gungame rooms. The
    // claim should pass every weapon gate and die at the expected
    // 'server-simmed' terminal, never at class/gun-game/instagib.
    combat.handleAOEShot('p1', {
      type: 'aoeShot', weaponType: gunGameWeapon(0),
      position: { x: 0, y: 10, z: -5 },
    });
    const reasons = rejects(sentTo);
    expect(reasons.some((r) => /class-locked|gun-game weapon|instagib weapon/.test(r))).toBe(false);
    expect(reasons).toContain('AOE: projectile blasts are server-simmed');
  });

  it('an off-ladder weapon still dies at the gun-game gate', () => {
    const { players, combat, sentTo } = aoeHarness({ gungame: true }, 0);
    const p = players.addPlayer('p1', undefined, 'none', 'light');
    p.position = { x: 0, y: 10, z: 0 };
    combat.handleAOEShot('p1', {
      type: 'aoeShot', weaponType: WeaponType.Melee,
      position: { x: 0, y: 10, z: -1 },
    });
    expect(rejects(sentTo)).toContain('AOE: gun-game weapon');
  });

  it('skill pseudo-weapons skip every weapon gate - Slam lives in gungame and instagib rooms', () => {
    for (const mods of [{ gungame: true }, { instagib: true }] as RoomMods[]) {
      const { players, combat, sentTo } = aoeHarness(mods, 0);
      const p = players.addPlayer('p1', undefined, 'none', 'light');
      p.position = { x: 0, y: 10, z: 0 };
      combat.handleAOEShot('p1', {
        type: 'aoeShot', weaponType: WeaponType.Slam,
        position: { x: 0, y: 10, z: -1 },
      });
      const reasons = rejects(sentTo);
      expect(reasons.some((r) => /class-locked|gun-game weapon|instagib weapon/.test(r))).toBe(false);
    }
  });
});
