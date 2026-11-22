import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { Vec3 } from '../../src/types.ts';

// The drawn-ghost uplink: a shooter's position report names the remote
// under its crosshair + the RENDERED spot. bodySweep/dischargeRay test
// the capsule there when the report is fresh and reachable - lateral DR
// drift lives at no rewind epoch, so this is how "hit what you saw"
// survives ghosts displaced sideways off the wire path.

function hp(room: ReturnType<typeof mkRoom>, id: string): number {
  return room.players.getPlayer(id)?.health ?? -1;
}

function pair(): { room: ReturnType<typeof mkRoom>; sh: Vec3; vic: Vec3 } {
  const room = mkRoom({ bots: 0 }, 'dm');
  room.players.addPlayer('sh');
  room.players.addPlayer('vic');
  const sh = { x: -30, y: 31, z: 0 };
  const vic = { x: 0, y: 31, z: 0 };
  pin(room, 'sh', sh);
  pin(room, 'vic', vic);
  return { room, sh, vic };
}

function fireAtDrawn(room: ReturnType<typeof mkRoom>, drawn: Vec3): void {
  // The shell flies along z=drawn.z - it threads the DRAWN capsule dead
  // center while passing ~4m lateral of every wire-epoch capsule.
  room.projectiles.spawn('sh', WeaponType.BoltLauncher,
    { x: -30, y: 31.4, z: drawn.z }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  step(room, 40);
}

describe('scenario: drawn-ghost aim report', () => {
  it('stores the reported ghost on the shooter via the position lane', () => {
    const { room, sh } = pair();
    room.wireIds.set('vic', 7);
    room.widToId.set(7, 'vic');
    room.messages.moves.handlePosition('sh', {
      type: 'position',
      position: Object.assign({}, sh), rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq: 1, aim: { wid: 7, x: 0, y: 31, z: 4 },
    });
    expect(room.players.getPlayer('sh')?.aimGhosts?.get('vic')?.z).toBe(4);
  });

  it('a second victim\'s report does not evict the first\'s ghost', () => {
    const { room, vic } = pair();
    room.players.addPlayer('vic2');
    pin(room, 'vic2', { x: 0, y: 31, z: 40 });
    room.wireIds.set('vic', 7); room.widToId.set(7, 'vic');
    room.wireIds.set('vic2', 8); room.widToId.set(8, 'vic2');
    const drawn = { x: vic.x, y: vic.y, z: vic.z + 4 };
    const hp0 = hp(room, 'vic');
    // Sweep paints vic, then the crosshair moves to vic2 - the old
    // single-slot report would have dropped vic's ghost before the
    // server shell's sweep read it.
    room.messages.moves.handlePosition('sh', {
      type: 'position',
      position: { x: -30, y: 31, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq: 1, aim: { wid: 7, x: drawn.x, y: drawn.y, z: drawn.z },
    });
    room.messages.moves.handlePosition('sh', {
      type: 'position',
      position: { x: -30, y: 31, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq: 2, aim: { wid: 8, x: 0, y: 31, z: 40 },
    });
    fireAtDrawn(room, drawn);
    expect(hp(room, 'vic')).toBeLessThan(hp0);
  });

  it('a shell through the drawn spot pays the body the wire never visited', () => {
    const { room, vic } = pair();
    const drawn = { x: vic.x, y: vic.y, z: vic.z + 4 }; // 4m lateral - unmissable vs wire epochs
    const hp0 = hp(room, 'vic');
    room.players.getPlayer('sh')!.aimGhosts = new Map([['vic', Object.assign({ at: wallNow() }, drawn)]]);
    fireAtDrawn(room, drawn);
    expect(hp(room, 'vic')).toBeLessThan(hp0);
  });

  it('without a report the same lateral shell is an honest miss', () => {
    const { room, vic } = pair();
    const hp0 = hp(room, 'vic');
    fireAtDrawn(room, { x: vic.x, y: vic.y, z: vic.z + 4 });
    expect(hp(room, 'vic')).toBe(hp0);
  });

  it('a forged ghost outside the rewind window buys nothing', () => {
    const { room, vic } = pair();
    const hp0 = hp(room, 'vic');
    // 6.5m lateral: inside the broad-phase margin (it must reach the
    // aim check) but outside the 6m reachability slack - the gate
    // refuses, so a shell threading the FORGED spot still misses.
    room.players.getPlayer('sh')!.aimGhosts = new Map([['vic', { x: vic.x, y: vic.y, z: vic.z + 6.5, at: wallNow() }]]);
    fireAtDrawn(room, { x: vic.x, y: vic.y, z: vic.z + 6.5 });
    expect(hp(room, 'vic')).toBe(hp0);
  });

  it('a blast inside the drawn spot but off the wire capsule still splashes', () => {
    const { room, vic } = pair();
    const hp0 = hp(room, 'vic');
    // Drawn 4m lateral of the wire pos, blast detonated there. Radius 3
    // discriminates: out of envelope at every wire epoch, dead center
    // at the rendered spot the shooter named.
    room.players.getPlayer('sh')!.aimGhosts = new Map([['vic', { x: vic.x, y: vic.y, z: vic.z + 4, at: wallNow() }]]);
    const stats = Object.assign({}, getWeaponStats(WeaponType.GrenadeLauncher), { aoeRadius: 3 });
    const { blast } = (room.messages.combat as unknown as { blast: { processAOE(id: string, pos: Vec3, ex: unknown, st: unknown, o: unknown): void } });
    blast.processAOE('sh', { x: vic.x, y: vic.y, z: vic.z + 4 }, null, stats, { weapon: WeaponType.GrenadeLauncher, trusted: true });
    expect(hp(room, 'vic')).toBeLessThan(hp0);
  });

  it('a report arriving after the shell swept past still pays the drawn body', () => {
    const { room, vic } = pair();
    room.wireIds.set('vic', 7);
    room.widToId.set(7, 'vic');
    const drawn = { x: vic.x, y: vic.y, z: vic.z + 4 };
    const hp0 = hp(room, 'vic');
    // Shell flies the drawn line with NO report yet - the live sweep
    // misses the wire capsule by 4m and keeps flying (the whiff shape:
    // close-range pops beat a 20Hz report + uplink to the read window).
    room.projectiles.spawn('sh', WeaponType.BoltLauncher,
      { x: -30, y: 31.4, z: drawn.z }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    step(room, 6); // ~0.3s - shell just past x=0, still live
    expect(hp(room, 'vic')).toBe(hp0);
    // Now the swept-hit report lands: retroactive check of the shell's
    // real flight path detonates it at the drawn spot.
    room.messages.moves.handlePosition('sh', {
      type: 'position',
      position: { x: -30, y: 31, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq: 1, aim: { wid: 7, x: drawn.x, y: drawn.y, z: drawn.z },
    });
    expect(hp(room, 'vic')).toBeLessThan(hp0);
  });

  it('a forged late report outside slack still buys nothing', () => {
    const { room, vic } = pair();
    room.wireIds.set('vic', 7);
    room.widToId.set(7, 'vic');
    const drawn = { x: vic.x, y: vic.y, z: vic.z + 6.5 }; // outside 6m slack
    const hp0 = hp(room, 'vic');
    room.projectiles.spawn('sh', WeaponType.BoltLauncher,
      { x: -30, y: 31.4, z: drawn.z }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    step(room, 6);
    room.messages.moves.handlePosition('sh', {
      type: 'position',
      position: { x: -30, y: 31, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq: 1, aim: { wid: 7, x: drawn.x, y: drawn.y, z: drawn.z },
    });
    step(room, 6);
    expect(hp(room, 'vic')).toBe(hp0);
  });

  it('the same blast without a report is an honest env refusal', () => {
    const { room, vic } = pair();
    const hp0 = hp(room, 'vic');
    const stats = Object.assign({}, getWeaponStats(WeaponType.GrenadeLauncher), { aoeRadius: 3 });
    const { blast } = (room.messages.combat as unknown as { blast: { processAOE(id: string, pos: Vec3, ex: unknown, st: unknown, o: unknown): void } });
    blast.processAOE('sh', { x: vic.x, y: vic.y, z: vic.z + 4 }, null, stats, { weapon: WeaponType.GrenadeLauncher, trusted: true });
    expect(hp(room, 'vic')).toBe(hp0);
  });
});
