import io, re
p='src/game/combat.ts'
s=io.open(p,encoding='utf-8').read()

a=s.index("  // ---- Projectile explosion processing")
b=s.index("\n  return {")
block=s[a:b]
s=s[:a]+s[b+1:]

# de-indent
lines=[l[2:] if l.startswith('  ') else l for l in block.split('\n')]
block='\n'.join(lines)

# signature + call rewrites inside the moved block
def sig(old,new): 
    global block
    assert old in block, old
    block=block.replace(old,new)

sig("function processProjectileExplosion(a: ExplosionArgs): void {",
    "function processProjectileExplosion(c: CombatCtx, a: ExplosionArgs): void {")
sig("function slam(pos: THREE.Vector3, impactSpeed: number): void {",
    "function slam(c: CombatCtx, pos: THREE.Vector3, impactSpeed: number): void {")
sig("function prunePendingShots(): void {","function prunePendingShots(c: CombatCtx): void {")
sig("function collectBoltIntercept(p: Projectile): void {","function collectBoltIntercept(c: CombatCtx, p: Projectile): void {")
sig("function chainStickies(src: Projectile): void {","function chainStickies(c: CombatCtx, src: Projectile): void {")
sig("function updateProjectiles(dt: number): void {","function updateProjectiles(c: CombatCtx, dt: number): void {")
sig("function boltCookoff(pos: THREE.Vector3): void {","function boltCookoff(c: CombatCtx, pos: THREE.Vector3): void {")
sig("function handleProjectileImpact(p: Projectile): void {","function handleProjectileImpact(c: CombatCtx, p: Projectile): void {")
sig("function spawnVisualOnly(p: Projectile): void {","function spawnVisualOnly(c: CombatCtx, p: Projectile): void {")
sig("function spawnImpactEffect(p: Projectile): void {","function spawnImpactEffect(c: CombatCtx, p: Projectile): void {")
sig("function spawnClusterBomblets(p: Projectile): void {","function spawnClusterBomblets(c: CombatCtx, p: Projectile): void {")
sig("function recordProjectileHit(p: Projectile): void {","function recordProjectileHit(c: CombatCtx, p: Projectile): void {")
sig("function logHitScore(p: Projectile, target: 'ball' | 'player', airborne: boolean): void {",
    "function logHitScore(c: CombatCtx, p: Projectile, target: 'ball' | 'player', airborne: boolean): void {")
sig("function onTargetDestroyed(ball: import('../entities/balls.js').Targetable, impulse?: THREE.Vector3, weaponType?: number): void {",
    "function onTargetDestroyed(c: CombatCtx, ball: import('../entities/balls.js').Targetable, impulse?: THREE.Vector3, weaponType?: number): void {")
sig("function handleBallHit(p: Projectile, ball: import('../entities/balls.js').Targetable): void {",
    "function handleBallHit(c: CombatCtx, p: Projectile, ball: import('../entities/balls.js').Targetable): void {")
sig("function handlePlayerHit(p: Projectile, playerId: string): void {",
    "function handlePlayerHit(c: CombatCtx, p: Projectile, playerId: string): void {")
sig("function hitTargetLocal(t: import('../entities/balls.js').Targetable, dmg: number): boolean {",
    "function hitTargetLocal(c: CombatCtx, t: import('../entities/balls.js').Targetable, dmg: number): boolean {")

# internal call sites -> c.-prefixed params
for n in ["processProjectileExplosion","boltCookoff","handleProjectileImpact","chainStickies",
          "prunePendingShots","collectBoltIntercept","spawnVisualOnly","spawnImpactEffect",
          "recordProjectileHit","spawnClusterBomblets","handleBallHit","handlePlayerHit",
          "logHitScore","onTargetDestroyed"]:
    block=re.sub(r'(?<![\w.])'+n+r'\(', 'c.'+n+'(', block)

# deps. / lg. / logger references stay — `lg` is in ctx as c.lg
block=block.replace("    lg.tickBeam(dt);","    c.lg.tickBeam(dt);")
block=block.replace("chainRamp.","c.chainRamp.")
block=block.replace("const chainRamp = new Map<number, { t: number; n: number }>();","")
block=block.replace("applyExplosionForce({","c.applyExplosionForce({")
# logger -> deps.logger
block=block.replace("logger.info(","deps.logger.info(")

ctx = '''interface CombatCtx {
  deps: CombatDeps;
  applyExplosionForce: ReturnType<typeof createBlastForce>['applyExplosionForce'];
  lg: { tickBeam: (dt: number) => void };
  chainRamp: Map<number, { t: number; n: number }>;
}

// ---- Projectile explosion processing (push or pull based on config) ----
''' + block
s=s.replace("// Combat pipeline: weapon fire","",0)
s=s.replace("export function createCombat", ctx + "\nexport function createCombat",1)

# factory: build ctx, thin wrappers
s=s.replace('''  const lg = createLightning(deps, {
    processExplosion: processProjectileExplosion,
    onTargetDestroyed,
    applyForceToRemotes,
  });
  const { lightning, updateBeamVisual } = lg;
''','''  const lg = createLightning(deps, {
    processExplosion: (a) => processProjectileExplosion(c, a),
    onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt),
    applyForceToRemotes,
  });
  const { lightning, updateBeamVisual } = lg;

  const c: CombatCtx = {
    deps,
    applyExplosionForce,
    lg: { tickBeam: lg.tickBeam },
    // Chaingun ramp state: targetId → last hit time + chain count.
    chainRamp: new Map(),
  };
''')
s=s.replace("const blast = createBlastForce(deps, { onTargetDestroyed });",
            "const blast = createBlastForce(deps, { onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt) });")
s=s.replace("const fire = createFire(deps, { onTargetDestroyed, applyForceToRemotes });",
            "const fire = createFire(deps, { onTargetDestroyed: (t, impulse, wt) => onTargetDestroyed(c, t, impulse, wt), applyForceToRemotes });")
s=s.replace("    slam,\n    updateProjectiles,","    slam: (pos: THREE.Vector3, impactSpeed: number) => slam(c, pos, impactSpeed),\n    updateProjectiles: (dt: number) => updateProjectiles(c, dt),")
s=s.replace("    hitTargetLocal,","    hitTargetLocal: (t, dmg) => hitTargetLocal(c, t, dmg),")
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
