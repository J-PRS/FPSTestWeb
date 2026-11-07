import { describe, it, expect, vi } from 'vitest';
import {
  kbEchoHorizon, kbStampDeadline,
  expectDamageEcho, confirmDamageEcho, hasPendingEcho,
  noteVictimDeath, noteVictimRespawn,
  noteShellFate, parityLines, parityProbes, sweepDamageEchoes, voidPendingEchoes,
} from '../game/parity.js';
import { WEAPONS } from '../../../shared/weapons.js';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';
import * as THREE from 'three';

// Pins for the lag-comp parity machinery proven in the wtsoak runs:
// verdict horizons, victim-death voiding, shot-aware consume, and the
// transit-corrected ghost epoch. Regression in any of these reproduces
// as silent dmg-echo/kb-echo misses in soak - the complaint classes.

const VID = (): string => `v${Math.random().toString(36).slice(2)}`;

describe('kbEchoHorizon', (): void => {
  it('floors at 1600 and grows with RTT, never below echo round-trip', (): void => {
    expect(kbEchoHorizon(0, 0)).toBe(1600);
    expect(kbEchoHorizon(50, 0)).toBe(1600);
    expect(kbEchoHorizon(350, 0)).toBe(1600); // volatile-lane flush ~1s post-destroy
    expect(kbEchoHorizon(700, 0)).toBe(1700);
  });
  it('stretches through wire silence but caps the stretch', (): void => {
    expect(kbEchoHorizon(0, 500)).toBe(2000); // +400 of stall
    expect(kbEchoHorizon(0, 10_000)).toBe(3600); // stall stretch capped at +2000
    expect(kbEchoHorizon(0, 50)).toBe(1600); // <100ms stall ignored
  });
});

describe('kbStampDeadline', (): void => {
  const H = 1000;
  it('a stamp with no pid expires at the plain horizon', (): void => {
    expect(kbStampDeadline({ t: 100 }, H)).toBe(1100);
  });
  it('a pid-bound stamp waits for its shell TTL + transit', (): void => {
    // Disc (wt 1) flies until contact - its destroy legitimately lands
    // ~10s out; a 4s deadline would miss the echo and raw-apply a double.
    const t = 5000;
    const d = kbStampDeadline({ t, pid: 'sp-1', wt: 1 }, H);
    const ttl = (WEAPONS[1]!.maxLifetime ?? 2) * 1000;
    expect(d).toBe(t + H + Math.min(ttl, 9000) + 1500);
    // Weapon TTL longer than the cap still caps at 9s.
    const d2 = kbStampDeadline({ t, pid: 'sp-2', wt: 4 }, H);
    expect(d2 - (t + H + 1500)).toBeLessThanOrEqual(9000);
  });
  it('a wire-destroyed stamp expires one horizon past the destroy', (): void => {
    expect(kbStampDeadline({ t: 100, pid: 'sp-1', wt: 1, wireT: 9000 }, H)).toBe(10_000);
  });
});

describe('damage echo ledger', (): void => {
  it('merges same victim+wt+shotId stamps, splits different ones', (): void => {
    const v = VID();
    const before = parityProbes.echoesStamped;
    expectDamageEcho(v, 25, 1, 'sh1');
    expectDamageEcho(v, 25, 1, 'sh1'); // same -> merge
    expectDamageEcho(v, 25, 1, 'sh2'); // new shot -> split
    expectDamageEcho(v, 25, 3);        // new wt -> split
    expect(parityProbes.echoesStamped - before).toBe(4);
    confirmDamageEcho(v, 'sh1');
    confirmDamageEcho(v, 'sh2');
    confirmDamageEcho(v);
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('shot-aware confirm prefers the matching stamp among same-victim echoes', (): void => {
    const v = VID();
    expectDamageEcho(v, 10, 1, 'AAA');
    expectDamageEcho(v, 40, 1, 'BBB');
    const before = parityProbes.echoesConfirmed;
    confirmDamageEcho(v, 'BBB');
    expect(parityProbes.echoesConfirmed - before).toBe(1);
    // AAA remains pending - a stray confirm can't eat the wrong stamp.
    expect(hasPendingEcho(v)).toBe(true);
    confirmDamageEcho(v);
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('a shotId-bound echo cannot expire before the shell TTL horizon', (): void => {
    const v = VID();
    expectDamageEcho(v, 50, 1, 'ttl1');
    const now = performance.now();
    // wt:1 maxLifetime=12s -> deadline = stamp + 900 + min(12000,9000):
    // sweeping at +5s must NOT expire it (the fate legitimately lands later).
    sweepDamageEchoes(now + 5000, 0);
    expect(hasPendingEcho(v)).toBe(true);
    // Past the horizon it expires.
    sweepDamageEchoes(now + 11_000, 0);
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('a victim who died around the stamp voids the verdict', (): void => {
    const v = VID();
    const voidsBefore = parityProbes.echoesVoided ?? 0;
    expectDamageEcho(v, 30, 1, 'dead1');
    noteVictimDeath(v); // server skips dead targets - echo can never confirm
    sweepDamageEchoes(performance.now() + 15_000, 0);
    expect(parityProbes.echoesVoided).toBe(voidsBefore + 1);
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('a respawned victim is judgeable again', (): void => {
    const v = VID();
    noteVictimDeath(v);
    noteVictimRespawn(v);
    expectDamageEcho(v, 30, 1, 'revive1');
    const voidsBefore = parityProbes.echoesVoided ?? 0;
    sweepDamageEchoes(performance.now() + 15_000, 0);
    expect(parityProbes.echoesVoided).toBe(voidsBefore); // missed, not voided
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('a non-server-simmed weapon echo expires silently', (): void => {
    const v = VID();
    expectDamageEcho(v, 25, 29); // wt:29 has no WEAPONS row -> never simmed
    sweepDamageEchoes(performance.now() + 15_000, 0);
    expect(hasPendingEcho(v)).toBe(false);
  });

  it('fates arriving after an expired shot count as fate-late, not a fresh verdict', (): void => {
    const v = VID();
    expectDamageEcho(v, 30, 1, 'late1');
    sweepDamageEchoes(performance.now() + 15_000, 0);
    noteShellFate('late1', { x: 1, y: 2, z: 3 }); // lands in expiredShots
    expect(parityProbes.fatesSeen).toBeGreaterThan(0);
  });

  it('a fan pull reports the fate nearest the predicted contact, not the last destroy', (): void => {
    const v = VID();
    const shot = `fan-${VID()}`;
    expectDamageEcho(v, 9, 6, shot, { x: 0, y: 0, z: 0 });
    noteShellFate(shot, { x: 100, y: 0, z: 0 }); // sibling pellet, far away
    noteShellFate(shot, { x: 2, y: 0, z: 0 });   // the pellet that mattered
    sweepDamageEchoes(performance.now() + 15_000, 0);
    const dump = parityLines().join('\n');
    expect(dump).toContain(`"shot":"${shot}"`);
    expect(dump).toContain('"srvAt":"2,0,0"');
    expect(dump).toContain('"fates":2');
  });

  it('a session reset voids pending echoes instead of reporting dead-wire misses', (): void => {
    const v = VID();
    const voidsBefore = parityProbes.echoesVoided ?? 0;
    expectDamageEcho(v, 25, 1, 'reconnect1');
    voidPendingEchoes(); // reclaim: the confirming playerHit died with the old socket
    expect(parityProbes.echoesVoided).toBe(voidsBefore + 1);
    expect(hasPendingEcho(v)).toBe(false);
    sweepDamageEchoes(performance.now() + 15_000, 0); // nothing left to expire
  });
});

// ---- The adjudicated ghost epoch ----
// The server rewinds a victim to shooterTransit + shooterViewLag -
// victimTransit; sampling the raw view ghost misses by (victimPing -
// shooterPing)/2. ghostPosition's arithmetic lives on RemotePlayer, but
// its inputs (viewEpochT, wirePingMs, sampleGhostAt) are all here.

const mkHost = (): InterpHost => ({
  position: new THREE.Vector3(),
  previousPosition: new THREE.Vector3(),
  rotation: { yaw: 0, pitch: 0, roll: 0 },
  velocity: new THREE.Vector3(),
  serverVelocity: new THREE.Vector3(),
  terrain: null, playerId: 'victim', armorClass: 'scout',
});

describe('transit-corrected ghost epoch', (): void => {
  it('wirePingMs carries the remote ping', (): void => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const ri = new RemoteInterp(mkHost());
      ri.onUpdate({ x: 0, y: 20, z: 0 }, { yaw: 0, pitch: 0 }, 160, { x: 0, y: 0, z: 0 }, 50);
      expect(ri.wirePingMs).toBe(160);
      vi.setSystemTime(1_000_050);
      ri.onUpdate({ x: 1, y: 20, z: 0 }, { yaw: 0, pitch: 0 }, 220, { x: 0, y: 0, z: 0 }, 100);
      expect(ri.wirePingMs).toBe(220);
    } finally { vi.useRealTimers(); }
  });

  it('the corrected epoch samples buffer truth the raw view epoch misses', (): void => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const ri = new RemoteInterp(mkHost());
      const SPD = 30; // 30 m/s mover
      let srvT = 0;
      for (let i = 0; i < 12; i += 1) {
        srvT += 50;
        ri.onUpdate({ x: srvT * 0.03, y: 20, z: 0 }, { yaw: 0, pitch: 0 }, 160, { x: SPD, y: 0, z: 0 }, srvT);
        vi.setSystemTime(1_000_000 + i * 16);
        ri.step(0.016, false);
      }
      // The correction: server judges at viewEpoch + (victimPing - shooterPing)/2.
      // Victim ping 160, shooter transit ~1ms -> +79ms of rewind shift; at
      // 30 m/s that is ~2.4m the raw view ghost would read stale.
      const viewEpoch = ri.viewEpochT;
      const shooterTransit = 1;
      const corrected = viewEpoch + ri.wirePingMs / 2 - shooterTransit;
      const gRaw = new THREE.Vector3();
      const gAdj = new THREE.Vector3();
      expect(ri.sampleGhostAt(viewEpoch, gRaw)).toBe(true);
      expect(ri.sampleGhostAt(corrected, gAdj)).toBe(true);
      const shift = gAdj.x - gRaw.x;
      // 79ms x 30m/s = 2.37m - the two epochs must differ by ~the victim's
      // transit share or the correction is a no-op (the soak's rim class).
      expect(shift).toBeGreaterThan(1.5);
      expect(shift).toBeLessThan(4);
    } finally { vi.useRealTimers(); }
  });
});
