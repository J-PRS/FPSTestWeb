// Scratch probe: post-fix flat-ground ski behavior — ski is now a pure
// friction toggle (no accel); the Jumpstart perk adds a one-shot
// +6 m/s on the press EDGE, gated at/below the class walk cap
// (max payout = cap + 6).
// CLASS_STATS (shared/botClasses.ts): light 14/12, medium 11/12, heavy 8/12.
import { MoveSim, MOVEMENT_CONFIG } from '../../../shared/movement.ts';
import { CLASS_STATS } from '../../../shared/botClasses.ts';

const flat = {
  getHeight: () => 0,
  getNormal: (_x: number, _z: number, out: { x: number; y: number; z: number }) => {
    out.x = 0; out.y = 1; out.z = 0; return out;
  },
};

const mk = (cls: 'light' | 'medium' | 'heavy', jumpstart = 0): MoveSim => {
  const st = CLASS_STATS[cls];
  const s = new MoveSim(flat as never, {
    pos: { x: 0, y: st.eyeHeight, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, onGround: true,
  } as never);
  s.speedScale = st.speedScale;
  s.mass = st.mass;
  s.eyeHeight = st.eyeHeight;
  s.bodyRadius = st.radius;
  s.jumpstart = jumpstart;
  return s;
};

const h = (s: MoveSim): number => Math.hypot(s.state.vel.x, s.state.vel.z);
const run = (s: MoveSim, seconds: number): void => {
  for (let i = 0; i < seconds * 60; i++) { s.update(1 / 60); }
};

for (const cls of ['light', 'medium', 'heavy'] as const) {
  const cap = MOVEMENT_CONFIG.maxVelocityGround * CLASS_STATS[cls].speedScale;
  console.log(`\n=== ${cls.toUpperCase()} (walk cap ${cap.toFixed(2)} m/s) ===`);

  // no perk: friction toggle only
  const s = mk(cls);
  s.setInput({ forward: 1 });
  run(s, 4);
  const v0 = h(s);
  s.setInput({ skiHeld: true });
  s.update(1 / 60);
  run(s, 3);
  console.log(`no perk — walk ${v0.toFixed(2)} -> ski+1step/3s: ${h(s).toFixed(3)} (should be ~${cap.toFixed(1)})`);
  // standstill + ski: pushes off at WALK speed (legs work), capped
  const t = mk(cls);
  t.setInput({ forward: 1, skiHeld: true });
  run(t, 1.5);
  console.log(`no perk — standstill + ski + fwd 1.5s: ${h(t).toFixed(3)} (expect ~${cap.toFixed(1)}, never above)`);

  // Jumpstart: edge +6 below cap, legs converge after; at-cap/fast -> 0
  const j = mk(cls, 6);
  j.setInput({ forward: 0, skiHeld: true });
  j.update(1 / 60);                                   // first step = pure edge boost
  console.log(`jumpstart — first ski step:          ${h(j).toFixed(3)} (expect 6.0)`);
  j.setInput({ forward: 1, skiHeld: true });
  run(j, 1.5);
  console.log(`jumpstart — ski+fwd 1.5s:            ${h(j).toFixed(3)} (legs converge to ${cap.toFixed(1)}, no re-fire)`);
  const k = mk(cls, 6);
  k.setInput({ forward: 1 });
  run(k, 4);
  k.setInput({ skiHeld: true });
  run(k, 0.5);
  console.log(`jumpstart — ski at walk cap:       ${h(k).toFixed(3)} (expect ${(cap + 6).toFixed(1)} — cap+boost is the max payout)`);
  const f = mk(cls, 6);
  f.state.vel.x = 30; // fast skier already at pace
  f.setInput({ skiHeld: true });
  run(f, 0.5);
  console.log(`jumpstart — ski at 30 m/s:         ${h(f).toFixed(3)} (expect ~30 — can't buy speed)`);
}
