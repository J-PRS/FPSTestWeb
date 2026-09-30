import io
p = 'src/game/species/siege.ts'
s = io.open(p, encoding='utf-8').read()

def cut(a_marker, b_marker, repl):
    global s
    a = s.index(a_marker); b = s.index(b_marker)
    blk = s[a:b]
    s = s[:a] + repl + s[b:]
    return blk

# reap loop -> module generic; keep species tick (before the cuts shift markers)
reap = '''  const overlordSpecies: Species<Overlord> = {
    list: overlords, interval: OVERLORD_SPAWN_INTERVAL, t: -100,
    spawn: spawnOverlord,
    tick: (m, dt) => { m.update(dt, deps.lazyTerrain(), aggroFor(m, m.pos, dt, PROFILES.siege)); kickTrail(m, dt); },
  };
  function updateOverlords(dt: number): void {
    updateSpecies(overlordSpecies, dt);
    reapSpecies(mines, targets, dt, (m) => m.update(dt, aggroFor(m, m.pos, dt, PROFILES.fodder)));
    reapSpecies(banelings, targets, dt, (b) => { b.update(dt, deps.lazyTerrain(), aggroFor(b, b.pos, dt, PROFILES.hunter)); kickDust(b, dt); });
  }
'''
old = s[s.index("  const overlordSpecies"):s.index("  // ---- Totems")]
s = s.replace(old, reap)

# cut the big spawn/detonate bodies -> module functions
plant = cut("  // ---- Overlords + mines", "  // Overlord brood:", "")
bane = cut("  // Overlord brood:", "  function spawnOverlord", "")
totem = cut("  // ---- Totems", "  function spawnUberTotem", "")

mod = '''interface SiegeKit {
  burrow: (e: { pos: THREE.Vector3 }) => void;
  blastAtPlayer: (origin: THREE.Vector3, radius: number, maxDmg: number, knockback: number, deathText: string, mult?: number) => number;
  hurtPlayer: (fromPos: THREE.Vector3, force: number, damage: number, deathText: string, reach?: number, attacker?: object) => boolean;
  boltPop: (pos: THREE.Vector3, scale: number, color: number, dur: number) => void;
  rollUber: () => boolean;
  ringPos: (min: number, max: number) => THREE.Vector3;
  atCap: (list: readonly unknown[], max: number) => boolean;
  removeTarget: <T>(list: T[], i: number, e: T) => void;
}

interface HasDead { dead: boolean; dispose(): void }
function reapSpecies<T extends HasDead>(list: T[], targets: T[], _dt: number, tick: (e: T) => void): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    tick(e);
    if (e.dead) {
      e.dispose();
      const ti = targets.indexOf(e);
      if (ti >= 0) targets.splice(ti, 1);
      list.splice(i, 1);
    }
  }
}

// ---- Overlords + mines (burrowing zone-denial — punishes camping) ----
function plantMineImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    mines: Mine[], targets: Mine[], pos: THREE.Vector3, uber = false): void {
  const { scene } = deps;
  const { burrow, blastAtPlayer } = kit;
  // Cap the field: dropping a new mine past the cap retires the oldest
  if (mines.length >= MINE_MAX) {
    const oldest = mines.shift()!;
    oldest.onDetonate = undefined; // retires quietly — no fake explosion
    oldest.dead = true;
    oldest.dispose();
    const ti = targets.indexOf(oldest);
    if (ti >= 0) targets.splice(ti, 1);
  }
  const m = new Mine(scene, deps.lazyTerrain(), pos, uber);
  burrow(m); // planted mines bury themselves — thematic even from an Overlord drop
  const player = deps.lazyPlayer();
  m.onDetonate = (mine) => {
    // Mine pop — compact dirty-orange blast, not a rocket. Doombloom's
    // blastRadius field carries its doubled envelope.
    deps.world.explosions.push(new Explosion(scene, mine.pos, false, 0, deps.lazyTerrain(), mine.blastRadius / ROCKET_RADIUS, 0xff7733));
    sfx.explosionAt(mine.pos, true);
    screenShake.blast(mine.pos, mine.uber ? 4 : 2.5, player.pos);
    blastAtPlayer(mine.pos, mine.blastRadius, MINE_DAMAGE_MAX, MINE_KNOCKBACK,
      mine.uber ? 'flowered by a doombloom' : 'blown up by a mine', mine.uber ? 1.5 : 1);
    if (mine.uber) {
      // Doombloom chain: its blast sets off every OTHER mine it touches —
      // clearing a doombloom field by shooting one is a gamble, not a plan.
      // Each mine's own dead flag means the chain terminates naturally.
      for (const other of mines) {
        if (!other.dead && other !== mine && other.pos.distanceToSquared(mine.pos) < mine.blastRadius * mine.blastRadius) {
          other.takeDamage(); // any damage detonates a mine
        }
      }
    }
  };
  mines.push(m);
  targets.push(m);
}

// Overlord brood: green sac pop — same blast read as a mine, but rolling
function spawnBanelingImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    banelings: Baneling[], targets: Baneling[], pos: THREE.Vector3, uber = false): void {
  const { scene } = deps;
  const { atCap, blastAtPlayer } = kit;
  if (atCap(banelings, capFor('baneling', BANELING_MAX))) return;
  const b = new Baneling(scene, deps.lazyTerrain(), pos, uber);
  if (b.dead) { b.dispose(); return; }
  const player = deps.lazyPlayer();
  b.onDetonate = (bane) => {
    // blastRadius is per-instance — a goliath pops 1.7× wider
    deps.world.explosions.push(new Explosion(scene, bane.pos, false, 0, deps.lazyTerrain(), bane.blastRadius / ROCKET_RADIUS, 0x77ff44));
    sfx.explosionAt(bane.pos, true);
    screenShake.blast(bane.pos, bane.uber ? 3.5 : 2.0, player.pos);
    if (blastAtPlayer(bane.pos, bane.blastRadius, BANELING_DAMAGE_MAX, BANELING_KNOCKBACK,
      bane.uber ? 'melted by a goliath' : 'melted by a baneling', bane.uber ? 1.4 : 1) > 0) {
      sfx.playerHurt();
    }
  };
  banelings.push(b);
  targets.push(b);
}

// ---- Totems (peak-seeking sniper obelisks) ----
// Uber totem — the elite sniper: predicts your velocity, tags a held
// course. One at a time; the fat gold obelisk + wide death ray IS the tell.
function spawnTotemImpl(deps: SpeciesCtx['deps'], kit: SiegeKit,
    totems: Totem[], targets: Totem[], uber = false): void {
  const { scene } = deps;
  const { atCap, ringPos, boltPop, hurtPlayer } = kit;
  if (deps.lazyDemoManager()?.isPlaying) return;
  const cap = uber ? UBER_TOTEM_MAX : capFor('totem', TOTEM_MAX);
  if (totems.filter(t => !t.dead && (!uber || t.uber)).length >= cap) return;
  const player = deps.lazyPlayer();
  const bolt = uber
    ? { scale: 0.6, color: 0xffaa33, popDur: 3.0, force: 14, dmg: UBER_TOTEM_BOLT_DAMAGE, text: 'sniped by the grand totem' }
    : { scale: 0.35, color: 0xff5566, popDur: 2.0, force: 8, dmg: TOTEM_BOLT_DAMAGE, text: 'struck down by a totem' };
  const t = new Totem(scene, deps.lazyTerrain(), ringPos(TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX), uber);
  t.onBoltLand = (pos) => boltPop(pos, bolt.scale, bolt.color, bolt.popDur);
  t.onBoltHit = () => {
    boltPop(player.pos.clone(), bolt.scale, bolt.color, bolt.popDur);
    hurtPlayer(t.pos, bolt.force, bolt.dmg, bolt.text, undefined, t);
  };
  t.onBlink = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'zap'); }; // departure puff at the old spot
  totems.push(t);
  targets.push(t);
}

'''
s = s.replace("// Siege family — things", mod + "// Siege family — things", 1)

# new thin wrappers inside the factory
anchor = "  // ---- Overlords + mines"
# insert thin wrappers after overlords decl block — put them where plantMine was
s = s.replace("  const totems: Totem[] = [];\n", '''  const totems: Totem[] = [];

  const siegeKit: SiegeKit = { burrow, blastAtPlayer, hurtPlayer, boltPop, rollUber, ringPos, atCap, removeTarget };
''')

s = s.replace("  const overlordSpecies: Species<Overlord> = {", '''  function plantMine(pos: THREE.Vector3, uber = false): void {
    plantMineImpl(deps, siegeKit, mines, targets, pos, uber);
  }
  function spawnBaneling(pos: THREE.Vector3, uber = false): void {
    spawnBanelingImpl(deps, siegeKit, banelings, targets, pos, uber);
  }
  function spawnTotem(uber = false): void {
    spawnTotemImpl(deps, siegeKit, totems, targets, uber);
  }

  const overlordSpecies: Species<Overlord> = {''', 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
