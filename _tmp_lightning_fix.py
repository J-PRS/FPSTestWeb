import io
p='src/game/combat/lightning.ts'
s=io.open(p,encoding='utf-8').read()

# cut lightning back out of module scope -> will re-add inside factory
a=s.index("function lightning(_e: FireArgs): void {")
b=s.index("\n// One beam tick of damage:",a)
lightning=s[a:b]
s=s[:a]+s[b+1:]

# fix updateBeamVisual body
s=s.replace("  if (!lgBeam || lgLastFire <= 0 || performance.now() - lgLastFire > 90) return;",
            "  if (!lg.beam || lg.lastFire <= 0 || performance.now() - lg.lastFire > 90) return;")
s=s.replace("  lgBeamTo.copy(_lgHit);\n  if (hitTarget) {\n    const chain = pickChain(deps, _lgHit, hitTarget);\n    if (chain) lgBeam.fireChain(_lgHit, chain.pos); else lgBeam.clearChain();\n  } else {\n    lgBeam.clearChain();\n  }",
            "  lg.beamTo.copy(_lgHit);\n  if (hitTarget) {\n    const chain = pickChain(deps, _lgHit, hitTarget);\n    if (chain) lg.beam.fireChain(_lgHit, chain.pos); else lg.beam.clearChain();\n  } else {\n    lg.beam.clearChain();\n  }")

# fix tickBeam
s=s.replace("""function tickBeam(dt: number): void {
  if (!lgBeam) return;
  lgBeam.update(dt);
  const lgAge = performance.now() - lgLastFire;
  if (lgLastFire > 0 && lgAge > 90) {
    sfx.beamLoopStop(); // trigger dropped — ramp the hum out
    lgLastFire = 0;
    lgBeam.clearChain();
  }""","""function tickBeam(lg: LgState, dt: number): void {
  if (!lg.beam) return;
  lg.beam.update(dt);
  const lgAge = performance.now() - lg.lastFire;
  if (lg.lastFire > 0 && lgAge > 90) {
    sfx.beamLoopStop(); // trigger dropped — ramp the hum out
    lg.lastFire = 0;
    lg.beam.clearChain();
  }""")

# adapt lightning body to lg.* and re-indent inside factory
lightning = lightning.replace("if (!lgBeam) lgBeam = new LightningBeam(deps.lazyScene());",
                              "if (!lg.beam) lg.beam = new LightningBeam(deps.lazyScene());")
lightning = lightning.replace("lgTrace(cam)","lgTrace(deps, cam, _traceT)")
lightning = lightning.replace("lgBeamTo.copy(_lgHit);","lg.beamTo.copy(_lgHit);")
lightning = lightning.replace("lgLastFire = lgNow;","lg.lastFire = lgNow;")
lightning = lightning.replace("lgSizzleAt = lgNow;","lg.sizzleAt = lgNow;")
lightning = lightning.replace("lgAnchorLive(deps, cam, _lgMuzzle);","lgAnchorLive(deps, cam, _lgMuzzle);")
lightning = lightning.replace("lgBeam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);",
                              "lg.beam.fire(_lgMuzzle, _lgHit, _lgO, hitT < LG_RANGE);")
lightning = lightning.replace("const chainT = pickChain(_lgHit, hitTarget);","const chainT = pickChain(deps, _lgHit, hitTarget);")
lightning = lightning.replace("lgBeam.fireChain(_lgHit, chainT.pos);","lg.beam.fireChain(_lgHit, chainT.pos);")
lightning = lightning.replace("zapTarget(hitTarget, stats.directDamage, cam);","zapTarget(deps, hooks, lg, hitTarget, stats.directDamage, cam);")
lightning = lightning.replace("zapTarget(chainT, stats.directDamage * LG_CHAIN_DMG_SCALE, cam);","zapTarget(deps, hooks, lg, chainT, stats.directDamage * LG_CHAIN_DMG_SCALE, cam);")
lightning = lightning.replace("(hitTarget || hitPlayerId) && lgNow - lgSizzleAt > 160","(hitTarget || hitPlayerId) && lgNow - lg.sizzleAt > 160")
lightning = '\n'.join('  '+l if l.strip() else l for l in lightning.split('\n'))

# insert before "  return {"
i=s.index("  return { lightning")
s=s[:i]+lightning+"\n\n"+s[i:]
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
