import { describe, it, expect } from 'bun:test';
import { ammoOf, spendAmmo, type AmmoPool } from '../../shared/weapons.ts';
import { WeaponType } from '../../shared/weaponTable.ts';
import { mkRoom, pin, seat } from './scenarios/harness.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { TickFanout, type FanoutMetrics } from '../src/tickRecords.ts';
import { wallNow } from '../src/wallClock.ts';

// PlasmaGun pilot economy: 20-round pool, regen 1 round per 2× fireInterval
// (0.2s) PAUSED while firing (one interval after the last shot) unless the
// pool is dry - a clean 2s full-rate burst, then half-cadence sustain.
describe('weapon ammo pool', () => {
  it('drains the clip under sustained fire, then trickles at half cadence', () => {
    const pool: AmmoPool = new Map();
    let t = 0;
    let fired = 0;
    // Full-cadence pulls every 0.1s: regen is paused one interval past
    // each shot, so exactly the 20-round clip fires - no accrual mid-burst.
    for (let i = 0; i < 20; i++) {
      if (spendAmmo(pool, WeaponType.PlasmaGun, t)) {fired += 1;}
      t += 0.1;
    }
    expect(fired).toBe(20);
    expect(spendAmmo(pool, WeaponType.PlasmaGun, t)).toBe(false); // dry
    // Next 1s of trigger-holding at a dry pool: regen ignores the pause
    // and funds ~5 rounds (one per 0.2s) - the half-cadence trickle.
    let trickle = 0;
    for (let i = 0; i < 10; i++) {
      if (spendAmmo(pool, WeaponType.PlasmaGun, t)) {trickle += 1;}
      t += 0.1;
    }
    expect(trickle).toBeGreaterThanOrEqual(4);
    expect(trickle).toBeLessThanOrEqual(6);
    t += 4;
    expect(ammoOf(pool, WeaponType.PlasmaGun, t)!).toBeCloseTo(20, 0);
  });

  it('pauses regen one fire interval after the last shot - mid-pool only', () => {
    const pool: AmmoPool = new Map();
    spendAmmo(pool, WeaponType.PlasmaGun, 0); // shotAt=0, ammo=19
    // Inside the pause window (shotAt + 0.1): no accrual.
    expect(ammoOf(pool, WeaponType.PlasmaGun, 0.05)!).toBeCloseTo(19, 5);
    // Past the window: 0.4s of idle regen at 1/0.2s = +2, capped at 20.
    expect(ammoOf(pool, WeaponType.PlasmaGun, 0.5)!).toBe(20);
  });

  it('uncapped weapons never gate; a cleared pool reads full again', () => {
    const pool: AmmoPool = new Map();
    expect(ammoOf(pool, WeaponType.Chaingun, 0)).toBeUndefined();
    expect(spendAmmo(pool, WeaponType.Chaingun, 0)).toBe(true);
    for (let i = 0; i < 25; i++) {spendAmmo(pool, WeaponType.PlasmaGun, i * 0.05);}
    expect(ammoOf(pool, WeaponType.PlasmaGun, 25 * 0.05)!).toBeLessThan(20);
    pool.clear(); // respawn path - absent cell = full pool
    expect(ammoOf(pool, WeaponType.PlasmaGun, 0)!).toBe(20);
  });

  it('server intent path debits the shooter pool on each accepted shot', async () => {
    const room = mkRoom({ bots: 2 });
    const a = room.players.addPlayer('SHOOTER', 'alpha', 'none', 'medium');
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    a.hasReceivedPosition = true; // skipRecord skips humans with no inputMove yet
    a.lastSeen = wallNow();
    seat(room, a.id); // sendToPlayer needs a live socket
    for (let i = 0; i < 3; i++) {
      room.messages.handleMessage(a.id, {
        type: 'shotFired', seq: i + 1,
        dir: { x: 1, y: 0, z: 0 },
        pos: { x: a.position.x, y: a.position.y, z: a.position.z },
        weaponType: WeaponType.PlasmaGun,
      } as never);
      await Bun.sleep(120); // above the 0.1s cadence law so the gate passes
    }
    // 3 debits less whatever the ~360ms accrual returned - well under cap.
    const banked = a.ammoPool.get(WeaponType.PlasmaGun)?.ammo;
    expect(banked).toBeGreaterThan(15);
    expect(banked).toBeLessThan(19.5);

    // Below-cap pool echoes the server count to the owner (yourAmmo) -
    // the echo lives in the fanout's per-player loop, not the sim step.
    const sent: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = ((id: string, m: ServerMessage): void => {
      sent.push(m);
      origSend(id, m);
    }) as typeof room.connections.sendToPlayer;
    const metrics = { recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0,
      tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0, recordsScanned: 0, scanNs: 0, frameNs: 0 } as FanoutMetrics;
    new TickFanout(metrics, () => {}).buildRecords(room, room.players.getAllPlayers(), wallNow());
    const echo = sent.find((m) => m.type === 'yourAmmo') as { ammo: [number, number][] } | undefined;
    expect(echo).toBeDefined();
    const [wt, n] = echo!.ammo.find(([w]) => w === WeaponType.PlasmaGun)!;
    expect(wt).toBe(WeaponType.PlasmaGun);
    expect(n).toBeGreaterThan(15);
    expect(n).toBeLessThan(20);
  });
});
