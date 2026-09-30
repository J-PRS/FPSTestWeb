import io, re

p = 'client/src/game/speciesKit.ts'
s = io.open(p, encoding='utf-8').read()

start = s.index('export function createSpeciesKit')
tail_marker = '  return {\n    removeTarget, ringPos, hurtPlayer, blastAtPlayer, bite,'
tail_i = s.index(tail_marker)
head = s[:start]
tail = s[tail_i:]
body = s[start:tail_i]

# header -> class + constructor
body = body.replace(
    "export function createSpeciesKit(deps: EntitiesDeps, targets: Targetable[], deployables?: () => DeployableRef | null) {",
    "class SpeciesKitImpl {\n  constructor(\n    private deps: EntitiesDeps,\n    private targets: Targetable[],\n    private deployables: () => DeployableRef | null = () => null,\n  ) {}")
body = body.replace('const { scene, logger } = deps;', 'private readonly scene = this.deps.scene;\n  private readonly logger = this.deps.logger;')

# function name<gen?>(args): ret {  ->  name = <gen?>(args): ret => {
body = re.sub(r'\n  function (\w+)(<.*?>)?\(', lambda m: '\n  ' + m.group(1) + ' = ' + (m.group(2) or '') + '(', body)
# close paren of that signature: turn '): ret {' into '): ret => {' — apply to converted lines' tails
body = re.sub(r'^(\s*\w+ = (<.*?>)?\([^)]*\)[^{]*)\{$', r'\1 => {', body, flags=re.M)

# const/let field declarations at class-body indent -> fields
body = re.sub(r'\n  const ', '\n  readonly ', body)
body = re.sub(r'\n  let ', '\n  ', body)

# member refs -> this. (identifiers followed by member-ish usage)
members = ['scene','logger','deps','targets','deployables','targetReg','_candMap','_candList','_zeroVel',
           '_candFrame','wanderReg','weaveReg','_weaveDir','_weaveOut','_stalkDir','lodAcc','dustAcc','trailAcc',
           'removeTarget','ringPos','hurtPlayer','bite','blastAtPlayer','candidates','syncLocalCandidate',
           'syncRemoteCandidates','pruneCandidates','wanderFor','stalkFor','frenzyFor','aggroFor','aggroVelFor',
           'reportTargetDamage','boltPop','updateSpecies','lodTick','tickGnaw','burrow','kickDust','kickTrail',
           'FRENZY_SCENT','FRENZY_RADIUS','ENGAGE_GRACE','RANDOM_SPAWNS','AI_LOD_MID_SQ','AI_LOD_FAR_SQ',
           'AI_LOD_MID_DT','AI_LOD_FAR_DT','LOD_BUCKETS','lodPhase']
pat = r'(?<![\w.\'"$])(' + '|'.join(re.escape(m) for m in members) + r')(?![\w$])'
body = re.sub(pat, 'this.\\1', body)
# declaration lines must not be 'this.name = ...' -> back to 'name ='
body = re.sub(r'\n  this\.(\w+) =', r'\n  \1 =', body)
body = re.sub(r'(readonly |private )this\.', r'\1', body)

# multi-line signature: bite(...) ends on its own line -> '): boolean {' needs '=>'
body = body.replace('\n  ): boolean {\n    const u = attacker.uber;', '\n  ): boolean => {\n    const u = attacker.uber;')

# expose the module-scope helpers the API object used to carry
body = body.replace('  ) {}\n', '  ) {}\n\n  readonly rollUber = rollUber;\n  readonly atCap = atCap;\n', 1)

# class field arrow bodies need ';' after their closing '}' — JS class fields
# tolerate missing semicolons via ASI, so leave as-is.

# tail: return literal -> nothing; type export uses class instance type
tail = tail.replace(
    "  return {\n    removeTarget, ringPos, hurtPlayer, blastAtPlayer, bite,\n    aggroFor, aggroVelFor, reportTargetDamage,\n    boltPop, updateSpecies, burrow, rollUber, kickDust, kickTrail, atCap,\n  };\n}\n\nexport type SpeciesKit = ReturnType<typeof createSpeciesKit>;",
    "}\n\nexport function createSpeciesKit(deps: EntitiesDeps, targets: Targetable[], deployables?: () => DeployableRef | null) {\n  return new SpeciesKitImpl(deps, targets, deployables);\n}\n\nexport type SpeciesKit = SpeciesKitImpl;")

out = head + body + tail
io.open(p, 'w', encoding='utf-8').write(out)
print('ok')
