import io
p = 'src/game/combat/lightning.ts'
s = io.open(p, encoding='utf-8').read()

# markers for extraction
a = s.index("  // Chain pick —")
b = s.index("  // One beam tick of damage:")
block = s[a:b]
s = s[:a] + "  const lg = { beam: lgBeam, lastFire: lgLastFire, sizzleAt: lgSizzleAt, beamTo: lgBeamTo, acc: lgAcc };\n\n" + s[b:]
# keep local refs for returned fns
s = s.replace("""  function zapTarget(t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {""",
"""  function zapTargetLocal(t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {
    zapTarget(deps, hooks, lg, t, dmg, cam);
  }
  function _unused(t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {""", 1)

# transform the block: deps.X -> deps.X already fine if we give deps param; strip 2-space indent, add params
lines = block.split('\n')
import re
out = []
for line in lines:
    if line.startswith('  '): line = line[2:]
    out.append(line)
block = '\n'.join(out)

# signature rewrites
block = block.replace("function pickChain(from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {",
                      "function pickChain(deps: CombatDeps, from: THREE.Vector3, exclude: (typeof deps.targets)[number]): (typeof deps.targets)[number] | null {")
block = block.replace("function lgPop(pos: THREE.Vector3, acc: number): void {",
                      "function lgPop(deps: CombatDeps, hooks: LightningHooks, pos: THREE.Vector3, acc: number): void {")
block = block.replace("function lgTrace(cam: THREE.Camera): {",
                      "function lgTrace(deps: CombatDeps, cam: THREE.Camera, traceT: { t: number }): {")
block = block.replace("  const _lgTraceT = { t: 0 };", "")
block = block.replace("const hitTarget = traceTargetHit(hitT);", "const hitTarget = traceTargetHit(deps, hitT, traceT);")
block = block.replace("hitT = _lgTraceT.t;", "hitT = traceT.t;")
block = block.replace("const hitPlayerId = tracePlayerHit(hitT);", "const hitPlayerId = tracePlayerHit(deps, hitT, traceT);")
block = block.replace("function traceTargetHit(hitT: number): (typeof deps.targets)[number] | null {\n  _lgTraceT.t = hitT;",
                      "function traceTargetHit(deps: CombatDeps, hitT: number, traceT: { t: number }): (typeof deps.targets)[number] | null {\n  traceT.t = hitT;")
block = block.replace("function tracePlayerHit(hitT: number): string | null {\n  _lgTraceT.t = hitT;",
                      "function tracePlayerHit(deps: CombatDeps, hitT: number, traceT: { t: number }): string | null {\n  traceT.t = hitT;")
block = block.replace("_lgTraceT.t", "traceT.t")
block = block.replace("sphereEntry(_lgTraceT.t", "sphereEntry(traceT.t")
# fix: sphereEntry calls became traceT.t already; remaining sphereEntry(hitT…): fine
block = block.replace("function sphereEntry(hitT: number, r: number, proj: number): number | null {",
                      "function sphereEntry(hitT: number, r: number, proj: number): number | null {")
block = block.replace("function updateBeamVisual(): void {", "function updateBeamVisual(deps: CombatDeps, lg: LgState): void {")
block = block.replace("    if (!lgBeam || lgLastFire <= 0 || performance.now() - lgLastFire > 90) return;",
                      "    if (!lg.beam || lg.lastFire <= 0 || performance.now() - lg.lastFire > 90) return;")
block = block.replace("const { hitT, hitTarget } = lgTrace(cam);", "const { hitT, hitTarget } = lgTrace(deps, cam, _traceT);")
block = block.replace("    lgBeamTo.copy(_lgHit);", "    lg.beamTo.copy(_lgHit);")
block = block.replace("const chain = pickChain(_lgHit, hitTarget);", "const chain = pickChain(deps, _lgHit, hitTarget);")
block = block.replace("      if (chain) lgBeam.fireChain(_lgHit, chain.pos); else lgBeam.clearChain();\n    } else {\n      lgBeam.clearChain();",
                      "      if (chain) lg.beam.fireChain(_lgHit, chain.pos); else lg.beam.clearChain();\n    } else {\n      lg.beam.clearChain();")
block = block.replace("lgBeam.fire(_lgMuzzle, lgBeamTo, cam.position, hitT < LG_RANGE);",
                      "lg.beam.fire(_lgMuzzle, lg.beamTo, cam.position, hitT < LG_RANGE);")
block = block.replace("function tickBeam(dt: number): void {\n    if (!lgBeam) return;\n    lgBeam.update(dt);\n    const lgAge = performance.now() - lgLastFire;\n    if (lgLastFire > 0 && lgAge > 90) {\n      sfx.beamLoopStop(); // trigger dropped — ramp the hum out\n      lgLastFire = 0;\n      lgBeam.clearChain();",
                      "function tickBeam(lg: LgState, dt: number): void {\n    if (!lg.beam) return;\n    lg.beam.update(dt);\n    const lgAge = performance.now() - lg.lastFire;\n    if (lg.lastFire > 0 && lgAge > 90) {\n      sfx.beamLoopStop(); // trigger dropped — ramp the hum out\n      lg.lastFire = 0;\n      lg.beam.clearChain();")

# lgAnchorLive also used inside module fns — hoist it out too (it only needs deps)
anchor = '''  function lgAnchorLive(cam: THREE.Camera, out: THREE.Vector3): void {
    if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
      lgMuzzleAnchor(cam, out); // fixed-offset fallback until the node exists
    }
  }
'''
s = s.replace(anchor, '')
block = block.replace("lgAnchorLive(cam, _lgMuzzle);", "lgAnchorLive(deps, cam, _lgMuzzle);")

lg_mod = '''interface LgState {
  beam: LightningBeam | null;
  lastFire: number;
  sizzleAt: number;
  beamTo: THREE.Vector3;
  acc: Map<number, number>;
}
const _traceT = { t: 0 };

// Beam start: the muzzle node's actual rendered pixel, unprojected into
// world space through the main camera — FOV difference between the
// viewmodel pass (55) and world pass (90) means a raw view-space offset
// lands on the wrong ray, which read as the bolt lagging the gun.
function lgAnchorLive(deps: CombatDeps, cam: THREE.Camera, out: THREE.Vector3): void {
  if (!deps.lazyViewModel()?.muzzleAnchorWorld(WeaponType.Lightning, cam, out)) {
    lgMuzzleAnchor(cam, out); // fixed-offset fallback until the node exists
  }
}

''' + block
s = s.replace("// Lightning gun: honest hitscan", lg_mod + "// Lightning gun: honest hitscan", 1)

# fix calls inside remaining factory body
fac_start = s.index("export function createLightning")
head, tail = s[:fac_start], s[fac_start:]
tail = tail.replace("lgAnchorLive(cam, _lgMuzzle);", "lgAnchorLive(deps, cam, _lgMuzzle);")
tail = tail.replace("const { hitT, hitTarget, hitPlayerId } = lgTrace(cam);", "const { hitT, hitTarget, hitPlayerId } = lgTrace(deps, cam, _traceT);")
tail = tail.replace("lgBeamTo.copy(_lgHit); // tip = exact aim point on the surface, no snap", "lg.beamTo.copy(_lgHit); // tip = exact aim point on the surface, no snap")
tail = tail.replace("lgLastFire = lgNow;", "lg.lastFire = lgBeam ? lgNow : lgNow;")
tail = tail.replace("      sfx.lgSizzle(_lgHit);", "      sfx.lgSizzle(_lgHit);")
tail = tail.replace("lgSizzleAt = lgNow;", "lg.sizzleAt = lgNow;")
tail = tail.replace("lgBeam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);", "lg.beam!.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);")
tail = tail.replace("if (!lgBeam) lgBeam = new LightningBeam(deps.lazyScene());", "if (!lg.beam) lg.beam = new LightningBeam(deps.lazyScene());")
tail = tail.replace("const chainT = pickChain(_lgHit, hitTarget);", "const chainT = pickChain(deps, _lgHit, hitTarget);")
tail = tail.replace("      if (chainT) {\n        lgBeam.fireChain(_lgHit, chainT.pos);", "      if (chainT) {\n        lg.beam!.fireChain(_lgHit, chainT.pos);")
tail = tail.replace("zapTarget(hitTarget, stats.directDamage, cam);", "zapTarget(deps, hooks, lg, hitTarget, stats.directDamage, cam);")
tail = tail.replace("zapTarget(chainT, stats.directDamage * LG_CHAIN_DMG_SCALE, cam);", "zapTarget(deps, hooks, lg, chainT, stats.directDamage * LG_CHAIN_DMG_SCALE, cam);")
tail = tail.replace("if (hitTarget || hitPlayerId) && lgNow - lgSizzleAt > 160", "if (hitTarget || hitPlayerId) && lgNow - lg.sizzleAt > 160")
s = head + tail

# zapTarget module fn: append to module section (before createLightning)
zap = '''// One beam tick of damage: number + health bar + bank toward the pop —
// every tick pumped into a target charges its burst. Shared by the
// primary strike and the chain fork.
function zapTarget(deps: CombatDeps, hooks: LightningHooks, lg: LgState,
    t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {
  deps.lazyDamageNumbers().spawn(t.pos, dmg, '#8fdcff', cam);
  const acc = (lg.acc.get(t.id) ?? 0) + dmg;
  lg.acc.set(t.id, acc);
  deps.reportTargetDamage?.(t, dmg);
  if (t.takeDamage(dmg)) {
    hooks.onTargetDestroyed(t, t.vel, WeaponType.Lightning);
    lgPop(deps, hooks, t.pos, acc);
    lg.acc.delete(t.id);
  } else if (!t.hideHealthBar) {
    deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);
  }
}

// Lightning gun: honest hitscan'''
s = s.replace("// Lightning gun: honest hitscan", zap, 1)

# state decls in factory — replace individual lets with lg object
tail = s[s.index("export function createLightning"):]
tail = tail.replace('''  let lgBeam: LightningBeam | null = null;
  let lgLastFire = 0;
  let lgSizzleAt = 0; // throttle the connect sizzle — one crackle per ~6 ticks
  const lgBeamTo = new THREE.Vector3(); // beam tip — follows the target between ticks
  // Beam charge per target — damage dealt this run, detonated on the kill.
  const lgAcc = new Map<number, number>();''',
'''  const lg: LgState = {
    beam: null,
    lastFire: 0,
    sizzleAt: 0, // throttle the connect sizzle — one crackle per ~6 ticks
    beamTo: new THREE.Vector3(), // beam tip — follows the target between ticks
    acc: new Map(), // beam charge per target — detonated on the kill
  };''')
tail = tail.replace("  const lg = { beam: lgBeam, lastFire: lgLastFire, sizzleAt: lgSizzleAt, beamTo: lgBeamTo, acc: lgAcc };\n\n", "")
s = s[:s.index("export function createLightning")] + tail

# remove the now-unused _unused/zapTargetLocal inner defs
s = s.replace('''  function zapTargetLocal(t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {
    zapTarget(deps, hooks, lg, t, dmg, cam);
  }
  function _unused(t: (typeof deps.targets)[number], dmg: number, cam: THREE.Camera): void {
    deps.lazyDamageNumbers().spawn(t.pos, dmg, '#8fdcff', cam);
    const acc = (lgAcc.get(t.id) ?? 0) + dmg;
    lgAcc.set(t.id, acc);
    deps.reportTargetDamage?.(t, dmg);
    if (t.takeDamage(dmg)) {
      hooks.onTargetDestroyed(t, t.vel, WeaponType.Lightning);
      lgPop(t.pos, acc);
      lgAcc.delete(t.id);
    } else if (!t.hideHealthBar) {
      deps.lazyHealthBarSystem().spawnBall(t, dmg, t.health);
    }
  }

''','')

# fix return + call sites of tickBeam/updateBeamVisual in factory
s = s.replace("return { lightning, updateBeamVisual, tickBeam };",
              "return { lightning, updateBeamVisual: () => updateBeamVisual(deps, lg), tickBeam: (dt: number) => tickBeam(lg, dt) };")
io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
