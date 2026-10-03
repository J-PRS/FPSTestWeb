import * as THREE from 'three';

export interface ProjectileConfig {
  name: string; // unique identifier, e.g. 'rocket', 'disc'
  displayName: string;
  weaponType: number; // numeric ID for demo protocol (0=rocket, 1=disc)
  speed: number;
  gravity: boolean; // world gravity bends the arc — never a custom value
  explosionRadius: number;
  force: number;
  forceMode: 'push' | 'pull';
  bodyRadius: number; // core hitbox for direct hits
  hitMin: number;
  hitMax: number;
  hitGrow: number;
  forceMultiplier: number;
  aoeDamage: number;
  aoeRadius: number;
  damageColor: string;
  trailColors: THREE.Color[];
  trailParticlesPerUnit: number;
  trailLifeMin: number;
  trailLifeMax: number;
  trailSpread: number;
  trailForwardSpread: number;
  trailParticleGravity: number;
  trailOpacity: number;
  trailBaseSize: number;
  trailSizeRange: number;
  trailScaleMin: number;
  trailScaleMax: number;
  trailRampIn: number;
  meshColor: number;
  meshType: string; // 'rocket', 'disc' — Projectile class dispatches on this
  glowShell: boolean;
  glowColor: number;
  glowOpacity: number;
  glowScale?: number; // override glow mesh size; defaults to hitRadius if not set
  /** Glow shell silhouette: 'sphere' = the classic proxy bubble; 'cone' =
   *  a vapor-cone (shock collar) — apex at the shell, flaring backward
   *  along -velocity, base radius still tracking hitRadius. */
  glowShape?: 'sphere' | 'cone';
  /** Armed-light pulse — the glow shell breathes in scale (per-instance
   *  matrix, so it survives material sharing). `fuseRamp` quickens the
   *  blink as maxLifetime runs out — the classic "beeping faster" tell. */
  glowPulse?: { hz: number; depth: number; fuseRamp?: boolean };
  meshRampIn?: boolean; // default ON — projectiles spawn small and grow; false = pop in at full size
  meshRampInDuration?: number; // default 0.2s, capped at 40% of maxLifetime
  meshStartScale?: number; // default 0.2
  terrainOffset: number;
  needsServerTracking: boolean;
  maxLifetime?: number; // 0 or undefined = no auto-explode; >0 auto-explodes after age reaches this (seconds)
  ttlJitter?: number; // per-shot fuse spread ±fraction, seeded from serverProjectileId so replicas agree
  trailMeshType?: 'sphere' | 'ring' | 'disc' | 'billboard'; // trail particle geometry; defaults to sphere
  noExplosion?: boolean; // true = hit produces no explosion/knockback (hitscan-style bullets)
  ribbonTrail?: boolean; // flat ribbon trail strip (single mesh, cheap) in addition to particles — ON by default; set false to opt out
  ribbonLanes?: number; // 1 = single strip; 3 = main band + 2 offset core lanes (default)
  ribbonWidth?: number;
  ribbonLife?: number;
  ribbonColor?: number;
  bounces?: boolean; // bounce off terrain instead of exploding (grenade launcher); fuse still applies
  bounceSfx?: string; // /sfx/<name>.ogg ping played positionally on each bounce
  bounceRestitution?: number; // velocity kept along the terrain normal per bounce
  bounceFriction?: number; // tangential velocity kept per bounce
  maxBounces?: number; // die on the Nth terrain hit (flak shards); undefined = bounce until fuse
  armTime?: number; // T2 mortar arming delay: contacts before this age BOUNCE, after it they detonate
  sticks?: boolean; // sticky launcher: on contact the bomb freezes in place and waits out its fuse; a detonation cooks off sibling sticks in radius
  /** Cluster carrier — detonation spawns `count` VISUAL bomblets
   *  (BOMBLET_CONFIG) in a cone of half-angle `spread` (rad) around the
   *  carrier's heading. `fuse` caps bomblet lifetime — omit for
   *  contact-only bombs that must land before they pop (MRV rain).
   *  Damage is server-side via WeaponStats.cluster. */
  cluster?: { count: number; spread: number; fuse?: number;
    /** true = uniform sphere scatter + full carrier-velocity inherit
     *  (MRV rain). Absent = upward cone biased along the carrier heading. */
    sphere?: boolean };
  /** Carrier-specific bomblet look — MRVBomblet config etc. Absent = the
   *  belt's shared BOMBLET_CONFIG. */
  bomblet?: ProjectileConfig;
  /** Body contact doesn't detonate — the shell flies through players and
   *  creatures (MRV carrier: a direct hit would make it a fast mortar;
   *  the fuse airburst IS the attack). Terrain bounce + interception
   *  by bolts/fields still apply. */
  passThroughTargets?: boolean;
  wakeVisual?: boolean; // turbulent wake particles marking the growing proxy hitbox (off by default — tuning pending)
  /** Mid-flight hitscan discharge (remote railgun): at `delay` seconds the
   *  slug fires a beam along its velocity — implemented as one giant swept
   *  step so terrain/target/obstacle hits apply to the beam — then dies at
   *  the hit point or at `range` on a clean miss. Values come from the
   *  shared WEAPONS table (rayDelay/rayRange) so the server's reach check
   *  allows the jump. */
  rayBurst?: { delay: number; range: number };
  /** Impact VFX variant — the blast's silhouette, per weapon family:
   *  'energy' = ring+spikes, no smoke (disc/plasma); 'kinetic' = a hard
   *  strike (railgun slugs, javelin); 'concussion' = heavy HE, blacker
   *  smoke + dirt debris (mortar/cannon/warhead); 'arc' = electric pop
   *  (lightning); 'splash' = droplets + mist (sprinkler hose);
   *  'punch' = melee puff. Unset = the shared powder recipe. */
  vfx?: 'splash' | 'punch' | 'energy' | 'kinetic' | 'concussion' | 'arc' | 'bolt' | 'flak';
  /** Terrain/structure hits: the shell stays planted at the contact point
   *  for N seconds, then shrinks away — a javelin quivering in the dirt.
   *  Combat resolution is unchanged (impact still reports immediately). */
  embeds?: number;
}

