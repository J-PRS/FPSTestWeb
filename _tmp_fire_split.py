import io
p='src/game/combat/fire.ts'
s=io.open(p,encoding='utf-8').read()

a=s.index("  function spawnProjectile")
b=s.index("  return {")
block=s[a:b]
s=s[:a]+"  return {\n"+s[b+len("  return {"):]

# de-indent + add params
lines=block.split('\n')
out=[]
for line in lines:
    if line.startswith('  '): line=line[2:]
    out.append(line)
block='\n'.join(out)

block=block.replace("function spawnProjectile(config: ProjectileConfig, e: FireArgs, quiet = false): void {",
                    "function spawnProjectile(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, quiet = false): void {")
block=block.replace("function freshFireArgs(): FireArgs {",
                    "function freshFireArgs(deps: CombatDeps): FireArgs {")
block=block.replace("function onBelt(_e: FireArgs, item: BeltItem): void {",
                    "function onBelt(deps: CombatDeps, _e: FireArgs, item: BeltItem): void {")
block=block.replace("setTimeout(() => spawnProjectile(config, freshFireArgs()), THROW_RELEASE * 1000);",
                    "setTimeout(() => spawnProjectile(deps, config, freshFireArgs(deps)), THROW_RELEASE * 1000);")
block=block.replace("function spawnFan(config: ProjectileConfig, e: FireArgs, count: number, spread: number): void {",
                    "function spawnFan(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, count: number, spread: number): void {")
block=block.replace("spawnProjectile(config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);",
                    "spawnProjectile(deps, config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);")
block=block.replace("function fireWeapon(def: WeaponDef, e: FireArgs): void {",
                    "function fireWeapon(deps: CombatDeps, def: WeaponDef, e: FireArgs): void {")
block=block.replace("if (def.pellets) { spawnFan(def.config, e, def.pellets.count, def.pellets.spread); return; }",
                    "if (def.pellets) { spawnFan(deps, def.config, e, def.pellets.count, def.pellets.spread); return; }")
block=block.replace("      spawnProjectile(def.config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel });",
                    "      spawnProjectile(deps, def.config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel });")
block=block.replace("    spawnProjectile(def.config, e);","    spawnProjectile(deps, def.config, e);")
block=block.replace("function melee(e: FireArgs): void {",
                    "function melee(deps: CombatDeps, hooks: FireHooks, e: FireArgs): void {")

s=s.replace("// projectiles (or a melee sweep), kicks the viewmodel, and reports the shot\n// to the server. The explosion/impact side lives in combat.ts.\nexport function createFire",
            block+"// projectiles (or a melee sweep), kicks the viewmodel, and reports the shot\n// to the server. The explosion/impact side lives in combat.ts.\nexport function createFire",1)
# BELT_THROWS stays inside the const decl region? it's inside block already (const at module scope now — fine, keep it).
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
