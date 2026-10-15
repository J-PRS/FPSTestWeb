import { describe, expect, test } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { MOVEMENT_CONFIG } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

const flat: Heightfield = { size: 2, data: new Uint8Array(4), stride: 1 };
const slopey: Heightfield = { size: 4, data: new Uint8Array(16).fill(128), stride: 1 };

describe('RoomMoveSim', () => {
  test('tracks, ticks, and follows a forward input', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false });
    for (let i = 0; i < 20; i++) {m.tick(0.05);}
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
  });

  test('honest report reconciles quietly; divergence returns sim truth', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) {m.tick(0.05);}
    // small drift — no divergence
    expect(m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0)).toBeNull();
    // 100m blink — correction state comes back, sim keeps its own truth
    // (resyncing onto the rejected report would ping-pong corrections).
    const truth = m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0);
    expect(truth).not.toBeNull();
    expect(Math.abs(m.simPos('p1')!.x)).toBeLessThan(8);
    // Throttled — an immediate second divergent report doesn't refire.
    expect(m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0)).toBeNull();
  });

  test('repeated teleport-scale divergences fire the cheat hook once', () => {
    const m = new RoomMoveSim(flat);
    let flagged = 0;
    m.onCheat = () => flagged++;
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0); // seed
    for (let i = 0; i < 5; i++) {m.reconcile('p1', { x: 100 + i, y: 0, z: 0 }, 0);}
    expect(flagged).toBe(1);
    // A drift-scale reporter (honest ~15m) never trips the window.
    m.track('p2', { x: 0, y: 0, z: 0 }, 0);
    m.reconcile('p2', { x: 1, y: 0, z: 0 }, 0);
    for (let i = 0; i < 5; i++) {m.reconcile('p2', { x: 20 + i * 3, y: 0, z: 0 }, 0);}
    expect(flagged).toBe(1);
  });

  test('resync resets to the declared position', () => {
    const m = new RoomMoveSim(slopey);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.resync('p1', { x: 50, y: 60, z: 50 }, 1);
    expect(m.simPos('p1')).toEqual({ x: 50, y: 60, z: 50 });
  });

  test('pre-resync reports (stale epoch seqs) never flag divergence', async () => {
    const m = new RoomMoveSim(flat, true);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) {m.tick(0.05);}
    m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0); // seed
    for (let s = 1; s <= 5; s++) {m.setInput('p1', { forward: 1 }, 0, s);}
    // Server respawns the player 100m away — the journal is cleared.
    m.resync('p1', { x: 100, y: 0, z: 100 }, 0);
    // A report still in flight from the corpse position (stamped seq 4,
    // at/below the resync seq) must not read as a blow-through.
    expect(m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0, undefined, 4)).toBeNull();
    // A NEW-epoch report is also muted inside the 1-RTT respawn grace —
    // the client hasn't seen its respawn yet and honestly reports the
    // corpse spot. Past the window it must flag again.
    expect(m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0, undefined, 6)).toBeNull();
    // New-epoch seq 7 outruns the consumed watermark (5): the in-flight
    // gap grace (600ms from streak start) defers it; past the window the
    // edge is provably lost and raw judging flags the stale spot again.
    await new Promise((r) => setTimeout(r, 620));
    expect(m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0, undefined, 7)).not.toBeNull();
  });

  test('untrack drops the shadow; null field is a no-op', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.untrack('p1');
    expect(m.simPos('p1')).toBeNull();
    const noField = new RoomMoveSim(null);
    noField.track('x', { x: 0, y: 0, z: 0 }, 0);
    expect(noField.simPos('x')).toBeNull();
  });

  test('gravity acts on the shadow', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 50, z: 0 }, 0);
    m.tick(0.05); // first tick just clears onGround — collision runs after move
    m.tick(0.05);
    expect(m.simPos('p1')!.y).toBeLessThan(50);
  });

  test('walking cannot exceed the ground speed cap', () => {
    // Regression: the overspeed bleed capped against post-input speed,
    // letting input accel push equilibrium far above maxVelocityGround.
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0 });
    let peak = 0;
    for (let i = 0; i < 300; i++) { // 15s of held-forward walking
      m.tick(0.05);
      const v = m.simState('p1')!.vel;
      peak = Math.max(peak, Math.hypot(v.x, v.z));
    }
    expect(peak).toBeGreaterThan(5);
    expect(peak).toBeLessThanOrEqual(MOVEMENT_CONFIG.maxVelocityGround + 0.01);
  });

  test('impulse overspeed bleeds off instead of snapping or sticking', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    const s = m.simState('p1')!;
    s.vel.x = 20; // a blast shove — above cap
    m.setInput('p1', { forward: 1 }); // walking during the slide
    let first = Infinity;
    for (let i = 0; i < 200; i++) {
      m.tick(0.05);
      const v = m.simState('p1')!.vel;
      const h = Math.hypot(v.x, v.z);
      if (i === 0) {first = h;}
    }
    const v = m.simState('p1')!.vel;
    const h = Math.hypot(v.x, v.z);
    expect(first).toBeGreaterThan(MOVEMENT_CONFIG.maxVelocityGround);
    expect(first).toBeLessThan(20);           // decays, doesn't snap
    expect(h).toBeLessThanOrEqual(MOVEMENT_CONFIG.maxVelocityGround + 0.01); // settles at cap, not above
  });

  test('config stays in lockstep with the client values', () => {
    expect(MOVEMENT_CONFIG.jumpSpeed).toBe(7);
    expect(MOVEMENT_CONFIG.maxVelocityGround).toBe(7);
  });

  test('modeled energy gates the jet claim — infinite jetting dries up', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.setInput('p1', { jetHeld: true });
    let peak = 0;
    for (let i = 0; i < 200; i++) { // 10s of claimed jet
      m.tick(0.05);
      peak = Math.max(peak, m.simPos('p1')!.y);
    }
    // 60 energy / 15 per sec ≈ 4s of thrust — after that gravity wins
    // and the player comes back down; an ungated sim would still climb.
    const {y} = m.simPos('p1')!;
    expect(peak).toBeGreaterThan(5);
    expect(y).toBeLessThan(peak);
  });

  test('featherjets perk burns the tank slower', () => {
    const base = new RoomMoveSim(flat);
    const feat = new RoomMoveSim(flat);
    base.track('b', { x: 0, y: 0, z: 0 }, 0);
    feat.track('f', { x: 0, y: 0, z: 0 }, 0, 'featherjets');
    base.setInput('b', { jetHeld: true });
    feat.setInput('f', { jetHeld: true });
    // At 5s the base tank (60/15=4s) is dry; featherjets (60/10.5≈5.7s)
    // is still burning and still climbing.
    for (let i = 0; i < 100; i++) { base.tick(0.05); feat.tick(0.05); }
    expect(feat.simPos('f')!.y).toBeGreaterThan(base.simPos('b')!.y);
  });

  test('cloak ante + drain charge the shadow tank', () => {
    const m = new RoomMoveSim(flat);
    // Stand above the collision plane — spawning under it tunnels.
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight + 0.5, z: 0 }, 0);
    // Rising edge on CLOAK costs 20 immediately, then 5/s while up;
    // recharge is suppressed while a toggle skill runs.
    m.setInput('p1', { jetHeld: true }, STATUS.CLOAK);
    let peak = 0;
    for (let i = 0; i < 100; i++) { m.tick(0.05); peak = Math.max(peak, m.simPos('p1')!.y); }
    // 40 energy after the ante ÷ (15+5)/s ≈ 2s of jet — much less
    // than the ~4s a clean tank buys.
    const base = 2.3;
    expect(peak).toBeGreaterThan(base);
    expect(peak).toBeLessThan(60);
  });

  test('authority mode tightens divergence + correction throttle', () => {
    const m = new RoomMoveSim(flat, true);
    expect(m.authoritative).toBe(true);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    for (let i = 0; i < 10; i++) {m.tick(0.05);}
    // First report is the spawn-landing seed — snaps the sim, never judges.
    expect(m.reconcile('p1', { x: 0, y: 0, z: 0 }, 0)).toBeNull();
    // 4m off — inside the correction snap budget (max(1.4×tol, 2m)),
    // past it: truth fires.
    expect(m.reconcile('p1', { x: 4, y: 0, z: 0 }, 0)).not.toBeNull();
    // Throttled at 100ms — an immediate second report doesn't refire.
    expect(m.reconcile('p1', { x: 2, y: 0, z: 0 }, 0)).toBeNull();
  });

  test('authority without a field falls back to judge (no sim, no flag)', () => {
    const m = new RoomMoveSim(null, true);
    expect(m.authoritative).toBe(false);
  });

  test('stale inputMove seqs are dropped — unordered transports can reorder', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight + 0.5, z: 0 }, 0);
    expect(m.setInput('p1', { forward: 1 }, 0, 5)).toBe(true);
    // A replayed earlier event must not rewind the input state.
    expect(m.setInput('p1', { forward: 0 }, 0, 3)).toBe(false);
    for (let i = 0; i < 20; i++) {m.tick(0.05);}
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
    // seq-less callers (old clients / tests) always pass.
    expect(m.setInput('p1', { forward: 0 })).toBe(true);
  });

  test('a grounded skier at a standstill can still push off', () => {
    // Regression: ski used to skip ground physics entirely, so a
    // zero-speed skier holding forward never accelerated (frozen bots).
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true });
    for (let i = 0; i < 20; i++) {m.tick(0.05);}
    const pos = m.simPos('p1')!;
    expect(Math.abs(pos.x) + Math.abs(pos.z)).toBeGreaterThan(0.5);
  });

  test('a report ahead of the shadow by in-flight inputs compares against the probe', () => {
    // The client consumed inputs the server hasn't received yet — its
    // position legitimately leads the sim by ~vel * pending. With the
    // inputSeq anchor this must not flag; without it the same report is
    // a teleport-scale divergence at ski speeds.
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, jumpHeld: false, skiHeld: true }, 0, 1);
    for (let i = 0; i < 60; i++) {m.tick(1 / 30);} // build up real speed
    const s = m.simState('p1')!;
    // A report ~4 steps ahead of the sim — inside probe range (cap 8).
    const ahead = { x: s.pos.x + s.vel.x * (4 / 30), y: s.pos.y, z: s.pos.z + s.vel.z * (4 / 30) };
    expect(m.reconcile('p1', ahead, 0, s.vel, 5)).toBeNull();
    // Same offset with no anchor (old client) → judged on stale state.
    // At ski speed the gap can exceed tolerance, so this is allowed to
    // flag — the assert that matters is above.
  });

  test('in-flight input gap defers strike banking, not corrections', async () => {
    // Live-net regression: a joiner whose first inputMove is still in
    // flight stamps reports with seqs past everything the server saw.
    // Judging those raw compares a jetting client against an input-
    // starved idle shadow — 60m+ in <1s — and 3 strikes latched the
    // cheat flag on honest queue latency (seen: 7 warns in one batch
    // right after a 16-bot join wave). Young gaps defer STRIKE BANKING
    // for 600ms (heartbeat + RTT) while corrections keep flowing; only a
    // SUSTAINED gap resumes banking, so real teleports still flag.
    const m = new RoomMoveSim(flat);
    let flagged = 0;
    let gaps = 0;
    m.onCheat = () => flagged++;
    m.onInputGap = () => gaps++;
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0); // seed
    const corr = m.reconcile('p1', { x: 100, y: 0, z: 0 }, 0, undefined, 9); // in-flight → young gap
    m.reconcile('p1', { x: 110, y: 0, z: 0 }, 0, undefined, 9);
    m.reconcile('p1', { x: 120, y: 0, z: 0 }, 0, undefined, 9); // streak 3 → inputSync hint
    expect(corr).not.toBeNull(); // corrections still flow — only banking defers
    expect(flagged).toBe(0); // queue latency banks no strikes
    expect(gaps).toBe(1);
    // Past the defer window the edge is provably lost — raw judging
    // resumes and teleport-scale departures still reach the latch.
    await new Promise((r) => setTimeout(r, 620));
    m.reconcile('p1', { x: 130, y: 0, z: 0 }, 0, undefined, 10);
    m.reconcile('p1', { x: 140, y: 0, z: 0 }, 0, undefined, 10);
    m.reconcile('p1', { x: 150, y: 0, z: 0 }, 0, undefined, 10);
    expect(flagged).toBe(1);
  });

  test('open input gap scales the severe bar by starved-input deficit', async () => {
    // RTC-congestion regression: while a report runs ahead of the input
    // watermark the shadow replays stale input, so an honest moving client
    // drifts speed×gapAge — a ~1s blackout at ski speed reads 60–99m and
    // banked teleport strikes (seen: ~3 warns/80s on a 16-bot RTC soak).
    // The severe bar now credits the deficit (speed×gap age, capped 2s):
    // divergences/corrections still count, strikes wait for a gap the
    // credit can't explain.
    const m = new RoomMoveSim(flat);
    let flagged = 0;
    m.onCheat = () => flagged++;
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0); // seed
    const s = m.simState('p1')!;
    s.vel.x = 30; // ski-speed shadow — credit = 30×gapAge
    // Open a gap: reports stamp seqs ahead of everything consumed.
    m.reconcile('p1', { x: 70, y: 0, z: 0 }, 0, undefined, 9);
    // Past the defer window the gap is still open — dist 70 > SEVERE_M 60
    // but inside 60 + 30×~0.62s credit: no strike banks.
    await new Promise((r) => setTimeout(r, 620));
    for (let i = 0; i < 4; i++) {m.reconcile('p1', { x: 70 + i, y: 0, z: 0 }, 0, undefined, 9);}
    expect(flagged).toBe(0);
    // A real teleport is a step function — far past the linear credit.
    m.reconcile('p1', { x: 300, y: 0, z: 0 }, 0, undefined, 10);
    m.reconcile('p1', { x: 310, y: 0, z: 0 }, 0, undefined, 10);
    m.reconcile('p1', { x: 320, y: 0, z: 0 }, 0, undefined, 10);
    expect(flagged).toBe(1);
  });

  test('a closed input gap keeps crediting the catch-up report', async () => {
    // 64-client soak regression: when the client's frame stream stalls,
    // the shadow FREE-RUNS the stale input — a ~1.5s stall at ski speed
    // ends with the catch-up report landing ~99m BEHIND it, precisely
    // when the streak closes to zero and the open-gap credit vanishes.
    // That single report banked a strike; the >severeM no-reseat rule
    // left the standing offset in place, so the same offset banked two
    // more and latched the cheat flag without any teleport evidence.
    const m = new RoomMoveSim(flat);
    let flagged = 0;
    m.onCheat = () => flagged++;
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    m.reconcile('p1', { x: 1, y: 0, z: 0 }, 0); // seed
    const s = m.simState('p1')!;
    s.vel.x = 60; // ski-speed shadow — the credit is speed × gap age
    // Open a sustained gap: the report's watermark leads everything the
    // server has consumed, so the streak arms and stays open.
    m.reconcile('p1', { x: 5, y: 0, z: 0 }, 0, undefined, 20);
    await new Promise((r) => setTimeout(r, 1520)); // stall the frame stream
    // The shadow free-runs the stale held input meanwhile: ~1.5s × 60.
    s.pos.x = 95;
    // Catch-up report: same seq (covered) closes the streak, dist ~90
    // > SEVERE_M 60 — inside the closed-gap credit (60 × 1.5s), so it
    // banks nothing and the reseat re-anchors the stale shadow.
    m.reconcile('p1', { x: 5, y: 0, z: 0 }, 0, undefined, 20);
    expect(flagged).toBe(0);
    expect(Math.round(s.pos.x)).toBe(5); // snapped to the honest report
    // Past the grace window the raw bars return: a real teleport still
    // banks three strikes and latches.
    await new Promise((r) => setTimeout(r, 2100));
    m.reconcile('p1', { x: 200, y: 0, z: 0 }, 0, undefined, 21);
    m.reconcile('p1', { x: 210, y: 0, z: 0 }, 0, undefined, 22);
    m.reconcile('p1', { x: 220, y: 0, z: 0 }, 0, undefined, 23);
    expect(flagged).toBe(1);
  });

  test('speed-scaled tolerance absorbs ski-speed drift but not teleports', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.setInput('p1', { forward: 1, right: 0, skiHeld: true }, 0, 1);
    for (let i = 0; i < 60; i++) {m.tick(1 / 30);}
    const s = m.simState('p1')!;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const tol = 10 * (1 + speed / 60);
    // Drift just under the scaled tolerance reconciles quietly.
    const near = { x: s.pos.x + tol * 0.9, y: s.pos.y, z: s.pos.z };
    expect(m.reconcile('p1', near, 0, s.vel)).toBeNull();
    // A real teleport still flags.
    expect(m.reconcile('p1', { x: s.pos.x + 200, y: s.pos.y, z: s.pos.z }, 0, s.vel)).not.toBeNull();
  });

  test('forged high-velocity reports cannot buy teleport tolerance', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0);
    m.reconcile('p1', { x: 0, y: MOVEMENT_CONFIG.playerHeight, z: 0 }, 0); // seed
    // Wire admits ≤1000 m/s claims; a 500 m/s report used to scale
    // lag/transit tolerance by ~4× before the judge clamped adoption
    // at the plausible ceiling (REPORT_VEL_CAP 200).
    const warp = { x: 900, y: 0, z: 0 }; // 900 > 200 — forged
    const blink = { x: 150, y: 0, z: 0 }; // past SEVERE_M even alone
    // First forged-vel report: correction must still fire (the claim
    // buys clamped-200 tolerance, not claimed-900).
    expect(m.reconcile('p1', blink, 0, warp)).not.toBeNull();
    // Shadow must not adopt the full forged velocity either — adoption
    // of ~900 m/s would compound into later tolerance windows.
    const v = m.simState('p1')!.vel;
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThanOrEqual(200 + 1e-6);
  });

  test('claim-declared uplink feeds the transit estimate; garbage is ignored', () => {
    const m = new RoomMoveSim(flat);
    m.track('p1', { x: 0, y: 0, z: 0 }, 0);
    expect(m.transitOf('p1')).toBe(0);
    // A measured-uplink sample lands on the server channel directly.
    m.feedUplink('p1', 80);
    expect(m.transitOf('p1')).toBe(80);
    // EMA converges toward the new stream's level.
    for (let i = 0; i < 20; i++) {m.feedUplink('p1', 40);}
    expect(m.transitOf('p1')).toBeLessThan(60);
    // Negative / NaN samples never touch the channel.
    m.feedUplink('p1', -5);
    m.feedUplink('p1', Number.NaN);
    expect(m.transitOf('p1')).toBeLessThan(60);
    // Untracked ids are a no-op.
    m.feedUplink('ghost', 80);
    expect(m.transitOf('ghost')).toBe(0);
  });
});
