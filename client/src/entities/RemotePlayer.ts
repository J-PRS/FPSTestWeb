import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';

import { PlayerModel, type PlayerModelVariant } from './PlayerModel.js';
import { CLASS_BODY_MAT_REV, CLASS_BODY_VARIANT } from './playerClips.js';
import { CLASS_MODEL_SCALE, classCapsule, classMass } from '../../../shared/botClasses.js';
import { RemoteInterp } from './remoteInterp.js';
import { RemoteGizmo } from './remoteGizmo.js';
import { resetCorpse, launchCorpse, stepCorpse, type CorpseState } from './remoteDeath.js';
import type { VerletRagdoll, GunDrop } from './verletRagdoll.js';
import { WeaponType, WEAPON_FIRE_INTERVAL_S } from '../../../shared/weapons.js';
import { RemoteAuras } from './remoteAuras.js';
import { RemoteAnim } from './remoteAnim.js';
import { HeldCrown } from './heldCrown.js';
import { hideRemote, showRemote, setStaleVis, setCloakVis, setCloakGhost, shootReveal, tickGhostF } from './remoteVis.js';
import { getShadows } from './swarms.js';
import { markProbe } from '../core/fxDiag.js';
import { debugOverlaysOn } from '../ui/hud/indicators.js';

const logger = new ChildLogger('RemotePlayer');

/**
 * Remote player representation with animated 3D model
 * Renders other players in the multiplayer game
 */
let _remotePlayerInstanceCounter = 0;

// Networked position.y is EYE height (feet + eyeHeight, per armor class -
// see movement.ts). The robot model's origin is at its feet, so the model
// renders `eyeOffset` below the networked position.

export class RemotePlayer {

  position: THREE.Vector3;
  /** Feet height - `position.y` is the networked EYE height; convert
   *  explicitly here instead of inline `- 1.8` at call sites (that's how
   *  the hitbox-vs-gizmo drift bug happened). */
  get feetY(): number { return this.position.y - this.eyeOff; }
  /** This body's eye-above-feet - per armor class (light 1.8, heavy 2.5). */
  get eyeOff(): number { return classCapsule(this.armorClass).eye; }
  rotation: { yaw: number; pitch: number; roll: number };
  playerId: string;
  readonly instanceId: number;
  _model: PlayerModel; // public - vis/anim family reads the loaded model
  previousPosition: THREE.Vector3; // public - anim drive derives speed from it
  _loaded = false;
  private _isDead = false;
  /** Headhunt hoard crown - the decomposed token pile orbiting the head,
   *  lazy-built on first nonzero held. Survives model rebuilds via
   *  finishModelLoad reattach. */
  private crown: HeldCrown | null = null;
  private crownHeld = 0;
  gizmo: RemoteGizmo | null = null;
  scene: THREE.Scene; // public - RemoteAuras builds bubbles in it
  // Shield bubble + status auras (mend/regen/dd/charge) - the lazy-glow
  // plumbing lives in remoteAuras.ts behind the AuraHost surface.
  auras = new RemoteAuras(this);
  velocity: THREE.Vector3 = new THREE.Vector3(); // public - anim drive reads it
  private angularVelocity: THREE.Vector3 = new THREE.Vector3();
  private isOnGround = true;
  terrain: Terrain | null = null; // public - anim drive ground-tests off it
  private corpse!: CorpseState; // ctor assigns - aliases live position/vel/rotation refs
  private ragdoll: VerletRagdoll | null = null;
  private gunDrop: GunDrop | null = null;
  serverVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity reported by server (public - interp family reads it)
  // Snapshot ingest, adaptive-delay interp, dead reckoning and the
  // predicted-knockback window - the whole netcode half lives in
  // remoteInterp.ts behind the InterpHost surface.
  private interp = new RemoteInterp(this);

  // Public getters for main.ts access (removes need for (as any) casts)
  get lastUpdateTime(): number { return this.interp.lastUpdate; }
  /** Last raw wire position - diagnostics only (render code reads the
   *  blended `position`). */
  get wirePosition(): THREE.Vector3 { return this.interp.wirePosition; }
  // Alias for the Forceable interface (Player/Ball use `pos`, we use `position`)
  get pos(): THREE.Vector3 { return this.position; }
  get isDead(): boolean { return this._isDead; }
  get scale(): number { return this.corpse.scale; }
  get isSimulating(): boolean { return this.interp.simulating; }
  /** Adaptive render delay this remote rides - lag-comp honesty input. */
  get renderDelayMs(): number { return this.interp.interpDelay; }
  /** Actual staleness of the last drawn sample - the epoch the server's
   *  lag-comp rewinds to when validating shots against this remote. */
  get viewLagMs(): number { return this.interp.viewLagMs; }
  /** The position the server's lag-comp adjudicates this remote at: the
   *  snapshot buffer sampled at the last drawn frame's server epoch -
   *  literally where the shooter saw them. Envelope math (blast/shock
   *  beams, shell sweeps) must read this - rendered pos ghosts hits on
   *  fast movers, wire pos leads them.
   *  The server's rewind is shooterTransit+lag−targetTransit, NOT the
   *  pure view epoch - a victim on a fatter pipe gets judged
   *  (victimPing−shooterPing)/2 ms LATER than the paint shows. Pass the
   *  shooter's transit so the sampled ghost lands on the adjudicated
   *  body, not the rendered one. */
  ghostPosition(out: THREE.Vector3, shooterTransitMs = 0): THREE.Vector3 {
    // localDriven first: GameBots write `position` directly and their
    // wirePosition is a frozen spawn record - the projection path below
    // would ghost the sweep back at spawn whenever lastUpdate got stamped.
    if (this.localDriven || this.lastUpdateTime <= 0) {return out.copy(this.position);}
    // The shooter's view epoch IS a server-time in the snapshot buffer -
    // sample the real history (turns, landings, bounces) instead of
    // projecting wire+vel, which missed direction changes by 15-25m.
    // Dead reckoning owns the body - the drawn position IS the view, and
    // the buffer's frozen epoch would sample a pre-sim ghost instead.
    if (this.interp.simulating) {return out.copy(this.position);}
    const epoch = this.interp.viewEpochT + this.interp.wirePingMs / 2 - shooterTransitMs;
    if (Number.isFinite(epoch) && this.interp.sampleGhostAt(epoch, out)) {return out;}
    // No rendered frame yet (pre-buffer boot) - project the wire record.
    const age = Math.min((Date.now() - this.lastUpdateTime) / 1000, 1);
    return out.copy(this.wirePosition).addScaledVector(this.vel, age - Math.max(0, this.interp.viewLagMs / 1000));
  }
  get interpUnderruns(): number { return this.interp.underruns; }
  get interpExtCapMs(): number { return this.interp.extCapMs; }
  get interpAtCap(): boolean { return this.interp.atCap; }
  get interpSimVel(): THREE.Vector3 { return this.interp.simVelocity; }
  get interpConverging(): boolean { return this.interp.converging; }
  /** The remote's own wire ping - server rewind depth needs the
   *  victim's transit, not just the shooter's view epoch. */
  get wirePingMs(): number { return this.interp.wirePingMs; }
  /** Ms to rewind the LOCAL body when the server judges me on this
   *  remote's behalf: shooterTransit + shooterViewLag - victimTransit.
   *  viewLagMs alone is (shooterPing - myPing)/2 shallow - a fat-pipe
   *  shooter's server body-sweeps me ~90ms deeper than their rendered
   *  epoch of me. Single owner of the formula - every prior kb-echo
   *  miss class was a caller that skipped the transit term. */
  rewindLocalMs(myPingMs: number): number {
    return this.viewLagMs + (this.wirePingMs - myPingMs) / 2;
  }
  /** Local authority (GameBot): position is written directly each frame,
   *  so the snapshot interp / dead-reckoning path would fight it - tick
   *  short-circuits to model+gizmo upkeep only. */
  localDriven = false;
  get loaded(): boolean { return this._loaded; }
  get model(): PlayerModel { return this._model; }
  // Server-reported velocity (for dust/trail effects); falls back to position-derived estimate
  get vel(): THREE.Vector3 {
    return this.serverVelocity.lengthSq() > 0.01 ? this.serverVelocity : this.velocity;
  }

  // Hard-sync position + all interpolation/simulation state to `pos`
  // (used by the ?dummy debug hook - suppresses dead reckoning drift)
  /** Armor-tier silhouette - heavy reads bulkier, light slimmer. Applied
   *  post-load because the GLB path sets its own fit scale. */
  private _classScale = 1;
  /** Armor class from the wire ('light'|'heavy'|undefined=medium) - the
   *  HUD indicator silhouette reads it. */
  armorClass?: string;
  setClass(cls?: string): void {
    this.armorClass = cls;
    this._classScale = CLASS_MODEL_SCALE[cls === 'light' || cls === 'heavy' ? cls : 'medium'];
    // The class IS the body: a tier change swaps the whole GLB, not a
    // scale factor - class bodies carry their own proportions.
    const want = (CLASS_BODY_VARIANT[cls ?? 'medium'] ?? 'vexa') as PlayerModelVariant;
    const rev = CLASS_BODY_MAT_REV.has(cls ?? 'medium');
    if (this._model.variant !== want || this._model.mannRev !== rev) {
      this._model.dispose();
      this._loaded = false;
      this._model = new PlayerModel(this.scene, want, rev);
      this._model.load().then((): void => this.finishModelLoad())
        .catch((error): void => logger.warn('Model swap gave up', { playerId: this.playerId, error: String(error) }));
      return;
    }
    if (this._loaded) {this.applyClassScale();}
  }
  private applyClassScale(): void {
    this._model.setScale(this._classScale);
    this._model.setColliderCapsule(classCapsule(this.armorClass));
  }

  /** Shared async-load tail for the constructor and the setClass rebuild:
   *  everything that was decided while the GLB was in flight gets
   *  reasserted onto the fresh model. */
  private finishModelLoad(): void {
      this._loaded = true;
      // Aim-probe tag - a body on the crosshair names its owner instead
      // of "untagged SkinnedMesh(helm)".
      if (this._model.object3D) {markProbe(this._model.object3D, { kind: 'fxMesh', label: `body:${this.playerId}` });}
      this.applyClassScale();
      this.model.setPosition(this.position.x, this.position.y - this.eyeOff, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch);
      // Shield may have gone up before the GLB landed (sphere fallback)
      // - upgrade it to the contoured shell once the bones exist.
      this.auras.upgradeContoured();
      // Show collider gizmo for remote players (unless already dead or stale-hidden)
      if (!this._isDead && !this.staleHidden) {
        this._model.setColliderVisible(true);
      }
      // Model may have been hidden while the GLB was still loading - reapply
      if (this.staleHidden) {
        this._model.setVisible(false);
      }
      if (this.cloakGhost) {setCloakGhost(this, true);}
      if (this._isDead) {this._model.setScale(this.corpse.scale);}
      this.applyCrown();
  }

  teleportTo(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.previousPosition.copy(pos);
    this.interp.reseat(pos);
  }

  constructor(scene: THREE.Scene, playerId: string, startPos: { x: number; y: number; z: number }, terrain?: Terrain, _armorClass?: string) {
    _remotePlayerInstanceCounter += 1;
    this.instanceId = _remotePlayerInstanceCounter;
    this.scene = scene;
    this.playerId = playerId;
    this.position = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    this.previousPosition = this.position.clone();
    this.rotation = { yaw: 0, pitch: 0, roll: 0 };
    this._isDead = false; // Reset death state on construction
    this.terrain = terrain || null;
    this.corpse = {
      position: this.position, velocity: this.velocity,
      angularVelocity: this.angularVelocity, rotation: this.rotation,
      landed: false, landedAt: 0, scale: 1,
    };
    this.interp.reset(this.position); // fresh interp state - prevents immediate dead reckoning

    this.gizmo = new RemoteGizmo(scene, startPos);
    logger.debug(`GIZMO ADDED`, { playerId, instanceId: this.instanceId });

    // Everyone wears their class body - light/medium/heavy are the UAS
    // silhouettes, picked from the constructor's wire class when present
    // (a mid-match re-fit rebuilds via setClass).
    this._model = new PlayerModel(scene,
      (CLASS_BODY_VARIANT[_armorClass ?? 'medium'] ?? 'vexa') as PlayerModelVariant,
      CLASS_BODY_MAT_REV.has(_armorClass ?? 'medium'));
    this.model.load().then((): void => {
      this.finishModelLoad();
      logger.debug(`MODEL LOADED`, { playerId, instanceId: this.instanceId, isDead: this._isDead });
    return; }).catch((error): void => {
      // load() rejects after 4 retries - the player stays a sphere
      // gizmo; log once instead of an unhandled rejection.
      logger.warn('Model load gave up', { playerId, error: String(error) });
    });
  }

  update(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, dt: number, ping = 0, serverVelocity?: { x: number; y: number; z: number }, serverMs?: number): void {
    // Dead-but-updating = the respawn echo dropped. The authority emits
    // positions only for live sims, so updates here mean this remote is
    // alive - revive off the first update past the kill, don't hold a
    // standing corpse while the live body shoots elsewhere.
    if (this._isDead) {this.respawn(targetPosition);}
    this.interp.onUpdate(targetPosition, targetRotation, ping, serverVelocity, serverMs);
    // NOTE: death physics (gravity, bounce, tumble, shrink) are handled in tick()
    // so they run every frame at the real dt - running them here at 20Hz with a
    // fixed dt made dead bodies fall/tumble at ~32% speed and look choppy.
  }

  // Called every frame for smooth interpolation
  tick(dt: number, camPos?: THREE.Vector3): void {
    if (camPos) {
      const dx = this.position.x - camPos.x, dz = this.position.z - camPos.z;
      this.camDistSq = dx * dx + dz * dz;
    }
    if (this._isDead) {
      this.tickDead(dt);
      return;
    }
    this.tickAlive(dt);
  }

  /** XZ distance² to the camera - gates the remote anim-LOD tiers below. */
  camDistSq = 0; // public - anim LOD tiers off it
  /** Render-only ground clearance the anim layer lifted this body by
   *  (slope footprint, wire dips). The HUD marker anchors off it or it
   *  sinks into the body whenever the lift is live. */
  renderLift = 0;
  /** Instanced blob-shadow pool handles - remotes ride the same pass the
   *  self blob and creatures do, so a grounded remote reads grounded even
   *  when the shadow-map pass is off (auto-quality, potato seed). */
  swarmSlot = -1;
  shadowSlot = -1;
  /** Camera-frustum test per network tick - offscreen bodies skip the
   *  mixer step entirely (the GPU already culls them; the CPU mixer was
   *  still ticking every bone). */
  onScreen = true; // public - remotes.ts writes it
  /** Accumulated dt the mixer still owes - far remotes animate in bursts
   *  at a lower cadence instead of paying a full mixer step every frame. */
  // Animation drive (locomotion pick, air trail, shoot/hit oneshots, mixer
  // LOD) lives in remoteAnim.ts; its internal timers moved with it.
  private readonly anim = new RemoteAnim(this);


  // Death physics (ragdoll-like rigidbody) run every frame at the real dt so
  // bodies fall/tumble/shrink at full speed and smoothly. Moved here from
  // update() which only fires at ~20Hz with a fixed dt - and now extracted
  // to remoteDeath.ts.
  private tickDead(dt: number): void {
    this.gunDrop?.step(dt, this.terrain);
    // Verlet path: the body stays visible and its skeleton flops under
    // the point sim. Rigidbody tumble is the fallback for unmapped rigs.
    if (this.ragdoll?.valid) {
      if (this.ragdoll.still > 1.5) {this.ragdoll.startSink();} // settled → slide under
      this.ragdoll.step(dt, this.terrain);
      this.ragdoll.apply();
      if (this.ragdoll.gone) {this._model.setVisible(false); this.ragdoll = null;} // only once submerged
      return;
    }
    stepCorpse(this.corpse, dt, this.terrain, this.eyeOff);

    // Update model if loaded (position/rotation/scale/animation)
    if (this._loaded) {
      this._model.setPosition(this.position.x, this.position.y - this.eyeOff, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);
      if (this.corpse.scale !== 1) {
        this._model.setScale(this.corpse.scale);
      }
      this._model.update(dt);
    }
  }

  /** Headhunt held-token crown - set every indicator tick; the ring
   *  rebuilds only on value change. Death strips the hoard wire-side so
   *  held=0 hides it without a death hook. */
  setHeld(held: number): void {
    if (held === this.crownHeld) {return;}
    this.crownHeld = held;
    this.applyCrown();
  }

  private applyCrown(): void {
    if (this.crownHeld <= 0 || this._isDead) {
      this.crown?.set(0);
      return;
    }
    if (!this.crown) {this.crown = new HeldCrown(this.scene);}
    this.crown.set(this.crownHeld);
  }

  /** Debug (?debug / menu DEBUG): wireframe capsules at the last wire
   *  position (cyan) and at the lag-comp adjudicated ghost (yellow) -
   *  the leash gap between what you see and what the server validates,
   *  rendered in world space. depthTest off so a buried wire reads
   *  through the terrain it's buried under. */
  private dbgGhosts: { wire: THREE.Mesh; adj: THREE.Mesh } | null = null;
  private _dbgVec = new THREE.Vector3();
  private dbgGhostClass: string | undefined;
  private tickDbgGhosts(dt: number): void {
    const want = debugOverlaysOn() && !this.localDriven && !this._isDead && this.lastUpdateTime > 0;
    if (!want) {
      if (this.dbgGhosts) { this.dbgGhosts.wire.visible = false; this.dbgGhosts.adj.visible = false; }
      return;
    }
    if (!this.dbgGhosts || this.dbgGhostClass !== this.armorClass) {
      this.disposeDbgGhosts();
      this.dbgGhostClass = this.armorClass;
      const mk = (hex: number): THREE.Mesh => {
        const cap = classCapsule(this.armorClass);
        const m = new THREE.Mesh(
          new THREE.CapsuleGeometry(cap.radius, cap.half * 2, 4, 8),
          new THREE.MeshBasicMaterial({ color: hex, wireframe: true, transparent: true, opacity: 0.55, depthTest: false }));
        m.renderOrder = 999;
        this.scene.add(m);
        return m;
      };
      this.dbgGhosts = { wire: mk(0x00_FF_FF), adj: mk(0xFF_EE_00) };
      // The adj ghost nests inside wire when the epochs coincide - a
      // stationary bot would otherwise hide cyan entirely (same
      // renderOrder, both depthTest:false → last draw wins).
      this.dbgGhosts.adj.scale.setScalar(0.92);
    }
    const cap = classCapsule(this.armorClass);
    const g = this.dbgGhosts!;
    const w = this.wirePosition;
    g.wire.visible = w.lengthSq() > 0;
    g.wire.position.set(w.x, w.y + cap.centerOff, w.z);
    this.ghostPosition(this._dbgVec);
    g.adj.visible = w.lengthSq() > 0;
    g.adj.position.set(this._dbgVec.x, this._dbgVec.y + cap.centerOff, this._dbgVec.z);
    this.dbgWatch(w, this._dbgVec, dt);
  }

  /** Frame-jump registrar: a wireframe hopping farther than its speed
   *  allows in one frame is an unexplained pop - the ghost source
   *  flipped or a stale packet reseated the wire. Registers the event
   *  with the interp state that produced it. */
  private _dbgPrevWire = new THREE.Vector3();
  private _dbgPrevAdj = new THREE.Vector3();
  private _dbgPrevPos = new THREE.Vector3();
  private _dbgPrevValid = false;
  private dbgWatch(w: THREE.Vector3, adj: THREE.Vector3, dt: number): void {
    if (this._dbgPrevValid) {
      // Wire delta is PER-RECORD motion - the wire only moves when a
      // record lands (~150-300ms apart), so its budget scales with the
      // measured arrival cadence, not frame dt. A 40m/s remote stepping
      // 3-10m per record is expected motion; the old per-frame budget
      // tripped on every single arrival.
      const wireBudget = Math.max(4, this.vel.length() * (this.interp.arrivalInterval / 1000) * 1.5 + 2);
      const budget = Math.max(3, this.vel.length() * dt * 2.5 + 2);
      const jw = w.distanceTo(this._dbgPrevWire);
      const ja = adj.distanceTo(this._dbgPrevAdj);
      const jp = this.position.distanceTo(this._dbgPrevPos);
      if (jw > wireBudget || ja > budget || jp > budget) {
        console.error(`[GLITCH:dbgghost-jump] ${JSON.stringify({
          id: this.playerId, wire: Number(jw.toFixed(1)), adj: Number(ja.toFixed(1)), model: Number(jp.toFixed(1)),
          sim: this.interp.simulating, conv: this.interpConverging,
          lagMs: Math.round(this.viewLagMs), delayMs: Math.round(this.interp.interpDelay),
          underruns: this.interpUnderruns, atCap: this.interpAtCap })}`);
      }
    }
    this._dbgPrevValid = true;
    this._dbgPrevWire.copy(w);
    this._dbgPrevAdj.copy(adj);
    this._dbgPrevPos.copy(this.position);
  }

  private disposeDbgGhosts(): void {
    if (!this.dbgGhosts) {return;}
    for (const m of [this.dbgGhosts.wire, this.dbgGhosts.adj]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.dbgGhosts = null;
  }

  private _blobPos = new THREE.Vector3();
  private tickAlive(dt: number): void {
    this.interp.step(dt, this.localDriven);
    this.tickDbgGhosts(dt);

    this.updateAliveModel(dt);

    // Crown follows the RENDERED model root (slope-lift included) but is
    // scene-parented - a model child would inherit body roll and lean
    // the beam off-vertical.
    if (this.crown) {
      this.crown.follow(this._model.model ? this._model.model.position : this.position, classCapsule(this.armorClass).height);
      this.crown.update(dt);
    }

    this.gizmo?.follow(this.position);

    const shadows = getShadows();
    if (shadows) {
      if (this.shadowSlot < 0) {this.shadowSlot = shadows.alloc(this);}
      this._blobPos.set(this.position.x, this.feetY, this.position.z);
      shadows.set(this, this._blobPos, classCapsule(this.armorClass).radius * 1.9, 0.35);
    }
  }

  /** Faint dots on the flight path - readable arc on a jetting bot,
   *  subtle enough not to pile on the jetpack flame itself. Emits at
   *  chest (eye −0.7); a >15m jump (teleport/respawn edge) drops the
   *  frame rather than streaking a dotted line across the map. */
  private updateAliveModel(dt: number): void {
    this.anim.tickModel(dt);
  }

  /** Wire ski flag, set by remotes.ts from playerState.ski - the anim pick
   *  trusts it over the speed heuristic: a grounded non-skiing mover is
   *  running, not sliding, even at ski speeds (momentum outlives the key). */
  wireSki: boolean | undefined;
  // Real jet claim when a driver knows it (bots write their brain's jet
  // button). Network remotes leave it undefined - the wire has no
  // jet bit, so callers fall back to the vel.y heuristic.
  wireJet: boolean | undefined;

  tickAuras(dt: number): void {
    this.auras.tick(dt);
  }

  /** Non-lethal hit feedback - the model plays the 'No' flinch briefly. */
  flinch(): void {
    if (!this._isDead) {this.anim.hitT = 0.35;}
    if (this._loaded) {this._model.damageFlash();} // creature-style white pop
    this.auras.flashShield(); // soaked - flare the lattice
  }

  playDeath(explosionPos?: THREE.Vector3, explosionForce?: number): void {
    this._isDead = true;
    this.crownHeld = 0; // the corpse spills its hoard - crown dies with it
    this.crown?.set(0);
    this.anim.hitT = 0;
    // Alive-path visual state (jet/strafe lean, reversed walk) is dead
    // code under tickDead - leave it set and the corpse keeps the lean.
    this._model.setBodyLean(0, 0);
    this._model.setLocomotionReversed(false);
    // Toggle channels die with the player - the corpse's wire row keeps
    // streaming the pre-death status bits until respawn clears them
    // server-side, and a corpse glowing shield/mend reads alive.
    this.auras.setShielded(false);
    this.auras.setMending(false);
    // A cloaked corpse must still render - remotes.ts zeroes dead rows'
    // status words, but bots reach setCloakHidden through botEnergy, so
    // the entity owns the guarantee at the death edge itself.
    setCloakVis(this, false);
    setCloakGhost(this, false);
    resetCorpse(this.corpse);
    launchCorpse(this.corpse, explosionPos, explosionForce);
    // Ragdoll disabled in-game for now - reads off; the gib burst carries
    // the death. Code + gunlab preview stay for the revisit.
    this.ragdoll = null;
    this.gunDrop = null;
    // A standing-height blob under a crumpled corpse reads wrong - the
    // slot re-allocs on the next tickAlive after respawn.
    getShadows()?.free(this);

    // Remove gizmo from scene immediately on death
    if (this.gizmo) {
      this.gizmo.detach();
      logger.debug(`GIZMO REMOVED on death`, { playerId: this.playerId });
    }

    // Remove collider gizmo from scene on death (not just hide it)
    this.model.removeColliderGizmo();
  }

  hide(): void { this.ragdoll = null; this.gunDrop?.restore(); this.gunDrop = null; hideRemote(this); }
  show(): void { showRemote(this); }

  /** Team tint on the name ring - Nugget Wars bots use it; server players
   *  could too once teamAssign lands on the wire. */
  setGizmoColor(hex: number): void {
    this.gizmo?.setColor(hex);
  }

  /** Debug hitbox wireframe tint - green friendly / red enemy, set from
   *  the same team verdict as the name gizmo. */
  setColliderColor(hex: number): void {
    this._model.setColliderColor(hex);
  }

  /** Set once the death gib burst has spawned — the roster-mirror death
   *  path and the kill wire can both reach gibBurst for one death; the
   *  flag keeps the debris single-spawn. Reset on respawn. */
  deathGibbed = false;

  respawn(position: { x: number; y: number; z: number }): void {
    this._isDead = false;
    this.deathGibbed = false;
    this.ragdoll = null;
    this.gunDrop?.restore(); this.gunDrop = null;
    resetCorpse(this.corpse);
    // Corpse shrink writes the MODEL's scale directly - reset it here or
    // a respawned player keeps the shrunken size forever (tickAlive never
    // re-asserts scale). Class scale, not 1: heavies respawn bulky.
    this._model.setScale(this._classScale);
    this.position.set(position.x, position.y, position.z);
    this.previousPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.serverVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    // Corpse tumble left pitch/roll on the shared rotation - network
    // remotes clear roll in interpolate() every frame, but localDriven
    // bodies (GameBot) never do, so they respawned lying on their side.
    this.rotation.pitch = 0;
    this.rotation.roll = 0;
    this.isOnGround = true;
    this.interp.reset(this.position);
    if (!this.cloakHidden) {showRemote(this);}
  }

  // Staleness gate: hide players whose updates stopped arriving (backgrounded
  // tabs keep their socket open but stop simulating). Auto-reshow on resume.
  // Public fields - RemoteAuras reads them to gate aura visibility.
  staleHidden = false;
  frustumHidden = false;
  cloakHidden = false;
  cloakGhost = false;
  get isCloakHidden(): boolean { return this.cloakHidden; }
  setStaleHidden(hidden: boolean): void { setStaleVis(this, hidden); }
  setCloakHidden(hidden: boolean): void { setCloakVis(this, hidden); }
  setCloakGhosted(on: boolean): void { setCloakGhost(this, on); }
  setShielded(on: boolean): void { this.auras.setShielded(on); }
  get isShielded(): boolean { return this.auras.isShielded; }

  setMending(on: boolean): void { this.auras.setMending(on); }
  get isMending(): boolean { return this.auras.isMending; }
  setRegenAura(on: boolean): void { this.auras.setRegenAura(on); }
  setDdAura(on: boolean): void { this.auras.setDdAura(on); }
  setCharged(on: boolean): void { this.auras.setCharged(on); }

  // Belt throws arrive as ordinary projectileCreated spawns - the throw
  // tell lives on the shooter's model, keyed off the spawned weaponType.
  // Sticky(18) is ambiguous (launcher AND belt share it) so it stays a
  // plain shot; a wrong dip is worse than a missing one.
  private static readonly THROW_TYPES = new Set([
    WeaponType.Implodisc, WeaponType.Grenade, WeaponType.ClusterBomb,
    WeaponType.Javelin, WeaponType.ImpactGrenade, WeaponType.RemoteRailgun,
    WeaponType.ArmorGrenade, WeaponType.Concussion, WeaponType.EMP,
    WeaponType.ProxyGrenade, WeaponType.SatchelCharge, WeaponType.BeltSticky,
    WeaponType.HealGrenade, WeaponType.Hook, WeaponType.BeltDisc,
  ]);

  // Remote fired a weapon - kick the gun's procedural recoil
  fire(weaponType?: number): void {
    // The mannequin's shot feedback is the recoil kick + muzzle flash -
    // its arm-chain aim layer owns the upper body, so playing the
    // Pistol_Shoot clip only flickers the arms off-aim. Other variants
    // still arm the shoot oneshot.
    // The shoot-state window must outlast the weapon's own fire interval:
    // a shot arriving while the timer is still ticking used to skip the
    // re-arm entirely (`<= 0` gate), so at fast cadences the pose dropped
    // to the neutral grip between every shot. +0.12 covers wire jitter.
    if (!this._isDead && this._model.variant !== 'mannequin') {
      const hold = Math.max(0.3, (weaponType === undefined ? 0 : WEAPON_FIRE_INTERVAL_S[weaponType as WeaponType] ?? 0) + 0.12);
      this.anim.shootT = Math.max(this.anim.shootT, hold);
    }
    if (this._loaded) {
      if (weaponType === WeaponType.Melee) {this._model.weaponPunch();}
      else if (weaponType !== undefined && RemotePlayer.THROW_TYPES.has(weaponType)) {this.playThrow();}
      else {this._model.fire(weaponType);}
    }
    // Firing decloaks: a cloaked shooter shimmers visible for a beat -
    // the price of shooting from stealth.
    shootReveal(this);
  }

  /** Belt throws (projectile spawns) and remote deploy placements both
   *  land here - the overhand swing clip where the rig ships one, else
   *  the procedural hand-prop dip alone. ~1.3s holds the throw state
   *  through the clip; rigs without it fall back to their old behavior. */
  playThrow(): void {
    if (!this._isDead) {this.anim.throwT = Math.max(this.anim.throwT, 1.3);}
    if (this._loaded) {this._model.weaponThrow();}
    shootReveal(this); // a throw is a shot - same decloak price
  }

  // Predicted knockback: run the victim through dead reckoning for ~1 RTT
  // while the real impulse (server → victim client → position updates)
  // travels the network. Seeds with the victim's last server velocity +
  // the exact server impulse math (dir*mag XZ, 0.5*mag up / 0.3 pull).
  // Snapshots are cleared so interpolation can't resample the pre-hit path
  // after the window - that stale-buffer resample was the old snap-back bug.
  ghostT = 0; // fire-shimmer display timer - remoteVis owns the decay
  revealT = 0; // shot-age window - stays live even before/without a cloak, so a late-rising cloak still owes its remainder
  tickGhost(dt: number): void { tickGhostF(this, dt); } // anim drive calls it post-locomotion

  applyPredictedKnockback(fromPos: THREE.Vector3, impulseMag: number, pull = false, dirFrom?: THREE.Vector3): void {
    // Mass gates the shove - the server divides its dv by class mass, so
    // the predicted window must or a heavy's arc overshoots and snaps back.
    this.interp.predict(fromPos, impulseMag / classMass(this.armorClass), pull, dirFrom);
  }

  // simulatePhysics() remains for genuine packet-loss dead reckoning.

  dispose(): void {
    logger.debug(`DISPOSE called`, { playerId: this.playerId, instanceId: this.instanceId });
    // Drop the loaded flag too - a dangling tick (debug hooks, orphaned
    // owner loop) must not walk into a cleared animation map.
    this._loaded = false;
    getShadows()?.free(this);
    this.auras.dispose();
    this.anim.dispose();
    this.crown?.dispose();
    this.crown = null;
    this._model.dispose();
    this.disposeDbgGhosts();
    if (this.gizmo) {
      this.gizmo.dispose();
      this.gizmo = null;
      logger.debug(`GIZMO REMOVED`, { playerId: this.playerId, instanceId: this.instanceId });
    }
  }
}
