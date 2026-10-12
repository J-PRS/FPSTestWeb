/**
 * SheepCore — THE anti-pedestrian meter, one implementation for every
 * body the game measures: wire humans (server_bun adapter), offline
 * bots, and the local player's own readout (client adapter).
 *
 * Meter starts at 100 — llama until proven otherwise. It drains only
 * while a body demonstrably holds/converts real mechanical energy
 * (sqrt(2E) past ~20 m/s-equiv, jetting, or welding); walking, hopping,
 * and slow falls are pedestrian motion even off the ground. Proven
 * play buys ~20s of grace: slowing down afterward charges at a trickle.
 * At 100 it clamps — a readout for badges/telemetry, not a lever.
 *
 * Channels (all in `why`, dumped when the meter maxes):
 *   idle   — per-second pedestrian charge (18 parked / 9 travelling /
 *            2 excused / negative while Tribes-ing)
 *   ignore — a visible live enemy and no shot in 3s (40/s)
 *   bleed  — losing mechanical E with no fight on screen (deadstop
 *            signature: clean skiing converts height↔speed losslessly)
 *   cover  — <30m of real 3D displacement per 5s while claiming a dest
 *
 * Sim time only — wall clock lies whenever a frame or tick is throttled.
 */

export interface SheepVec { x: number; y: number; z: number }

export interface SheepSample {
  pos: SheepVec;
  vel: SheepVec;
  /** Metres of air under the body (terrain or structure top). */
  height: number;
  dt: number;
  /** A live enemy is within brawl evidence (each side gates LOS itself). */
  foe: boolean;
  /** The body claims a destination — the coverage stall's ground truth. */
  hasDest: boolean;
  /** Where it claims to be going — parked within ~14m is a posted guard. */
  dest?: SheepVec;
  /** Tank→potential conversion is the work — always Tribes-ing. */
  jetting?: boolean;
  /** Repair beams out — honest work, not pedestrian. */
  repair?: boolean;
  /** Caller-known busy work (offline weld intent). */
  busy?: boolean;
  /** Caller-computed refusal override — default: `foe` and no shot in
   *  the last 3s (the meter's own fire ledger). */
  refusingFire?: boolean;
}

export interface SheepWhy { idle: number; ignore: number; bleed: number; cover: number }

export interface SheepVerdict {
  meter: number;
  /** Rose into the 100 cap this tick — log it, don't repeat it. */
  newlyMaxed: boolean;
  /** Crossed 60 upward this tick (server's 'high' info line). */
  crossedHigh: boolean;
  why: SheepWhy;
}

export class SheepCore {
  private meter = new Map<string, number>();
  private cov = new Map<string, { start: number; dist: number; lx: number; ly: number; lz: number }>();
  private lastFire = new Map<string, number>();
  private eSm = new Map<string, number>();
  private eLast = new Map<string, number>();
  private eParts = new Map<string, { ke: number; pe: number; mech: number }>();
  private provenUntil = new Map<string, number>();
  private why = new Map<string, SheepWhy>();
  private maxed = new Set<string>();
  /** Windows that measure play must run on sim time — wall clock lies
   *  whenever a frame or tick is throttled. */
  private simMs = 0;

  /** Advance the sim clock once per frame/tick — NOT per body: doing it
   *  inside tick() scaled every 5s window by the roster size. */
  step(dt: number): void { this.simMs += dt * 1000; }
  get now(): number { return this.simMs; }

  /** A real shot — refreshes the ignore debit's 3s recency window so an
   *  engaged body in legal volley cadence (0.8–1.9s) doesn't read passive. */
  noteFire(id: string): void { this.lastFire.set(id, this.simMs); }
  notShooting(id: string): boolean {
    return this.simMs - (this.lastFire.get(id) ?? -Infinity) > 3000;
  }

  /** Identity change (team defect/rekey) — carry every per-id cell so the
   *  body keeps its earned meter instead of reading as a fresh leash. */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) {return;}
    const mv = <T>(m: Map<string, T>): void => { const v = m.get(oldId); m.delete(oldId); if (v !== undefined) {m.set(newId, v);} };
    mv(this.meter); mv(this.cov); mv(this.lastFire); mv(this.eSm); mv(this.eLast);
    mv(this.eParts); mv(this.provenUntil); mv(this.why);
    if (this.maxed.delete(oldId)) {this.maxed.add(newId);}
  }

  /** Respawn is a fresh leash — unproven = 100. */
  clear(id: string): void {
    this.meter.delete(id);
    this.cov.delete(id);
    this.lastFire.delete(id);
    this.eSm.delete(id);
    this.eLast.delete(id);
    this.eParts.delete(id);
    this.provenUntil.delete(id);
    this.why.delete(id);
    this.maxed.delete(id);
  }

  /** No ticks on record = unproven = full meter. */
  of(id: string): number { return Math.round(this.meter.get(id) ?? 100); }
  set(id: string, v: number): void { this.meter.set(id, v); }
  energyOf(id: string): { ke: number; pe: number; mech: number } | undefined {
    return this.eParts.get(id);
  }

  tick(id: string, s: SheepSample): SheepVerdict {
    const { mech, bonusSpeed } = this.energy(id, s);
    // Tribesing = holding/converting real E. Bare airborne doesn't
    // qualify — a low-speed hop is pedestrian motion that left the
    // ground; jetting and repair beams are the work itself.
    const tribesing = bonusSpeed > 20 || Boolean(s.jetting) || Boolean(s.repair) || Boolean(s.busy);
    if (tribesing) {this.provenUntil.set(id, this.simMs + 20_000);}
    const proven = this.simMs < (this.provenUntil.get(id) ?? 0);
    const prev = this.meter.get(id) ?? 100;
    const why = this.ledger(id);
    // Holding the post is work, not sheep: a HoF parked ON its stand
    // dest looks identical to a llama from speed alone. "Arrived" gets
    // the trickle — it still maxes if the bot sleeps on a stale point.
    const atPost = s.hasDest && s.dest !== undefined &&
      Math.hypot(s.pos.x - s.dest.x, s.pos.z - s.dest.z) < 14;
    const excused = atPost || proven;

    let meter = prev;
    // Rate-capped drain: a high-E burst (60m/s plummet) used to zero a
    // full meter in a second, reading as a reset. Faster play still
    // drains faster — just never in a single step.
    let drain = 18;
    if (excused) {drain = 2;}
    else if (s.hasDest) {drain = 9;}
    const base = s.dt * (tribesing
      ? -Math.min(12 + bonusSpeed * 0.6 + (s.jetting ? 15 : 0), 30)
      : drain);
    if (base > 0) {why.idle += base;}
    meter += base;

    // Fastest cowardice tell: a visible live enemy and a sustained
    // refusal to fire. Only counts a PARKED body — a skiing one is
    // playing Tribes even while it holds fire.
    const refusing = s.refusingFire ?? this.notShooting(id);
    const parked = s.vel.x * s.vel.x + s.vel.y * s.vel.y + s.vel.z * s.vel.z < 4;
    if (!tribesing && s.foe && refusing && parked) {
      const ig = s.dt * 40;
      why.ignore += ig;
      meter += ig;
    }

    // Bleeding total E without a fight on screen is the deadstop
    // signature — Tribes play converts height↔speed losslessly, so E
    // only drops on face-plants, wall hits, and pedestrian friction.
    const bleed = this.energyBleed(id, mech, s.foe);
    if (bleed > 0) { why.bleed += bleed; meter += bleed; }

    // Coverage is the ground truth — gate it on the busy exemption, not
    // tribesing: a body going nowhere accrues even if a stale velocity
    // still credits it energy.
    if (!s.busy) {
      const cover = this.coverageDebit(id, s.pos, s.hasDest);
      if (cover > 0) { why.cover += cover; meter += cover; }
    }

    const crossedHigh = prev < 60 && meter >= 60;
    const clamped = Math.max(0, Math.min(100, meter));
    this.meter.set(id, clamped);
    // Warn only on the RISE into the cap — bodies start at 100 (llama
    // until proven), so a fresh spawn at the cap isn't a maxed event.
    const newlyMaxed = clamped >= 100 && prev < 100 && !this.maxed.has(id);
    if (clamped >= 100 && prev < 100) {this.maxed.add(id);}
    else if (clamped < 100) {this.maxed.delete(id);}
    return { meter: clamped, newlyMaxed, crossedHigh, why };
  }

  /** Total mechanical energy (kinetic + potential) is the Tribes
   *  currency — a fast body low to the ground and a slow body on a
   *  perch both hold real E. Potential counts at half gravity past a
   *  2m deadband — and only while moving: a parked body at altitude
   *  isn't holding energy to convert, it's sleeping on the deposit. */
  private energy(id: string, s: SheepSample): { mech: number; bonusSpeed: number } {
    const v = s.vel;
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
    const pe = speedSq > 4 ? 4.9 * Math.max(0, s.height - 2) : 0;
    const mech = 0.5 * speedSq + pe;
    this.eParts.set(id, { ke: 0.5 * speedSq, pe, mech });
    const ePrev = this.eSm.get(id) ?? mech;
    const eSm = ePrev + (mech - ePrev) * Math.min(1, s.dt * 5);
    this.eSm.set(id, eSm);
    return { mech, bonusSpeed: Math.sqrt(Math.max(0, 2 * eSm)) };
  }

  /** Instantaneous E loss ending near a deadstop, clamped — a body
   *  sliding to a halt bleeds once, not forever. Gated on the LANDING
   *  energy, not just the drop: without it, every uphill leg of a
   *  legit ski route "bleeds" — rolling-terrain transit made this the
   *  dominant channel on every maxed bot (soak: 480/600pts = transit
   *  decel, not sheeping). A near-stop after the dump is the actual
   *  llama tell. */
  private energyBleed(id: string, mech: number, foe: boolean): number {
    const ePrev = this.eLast.get(id);
    this.eLast.set(id, mech);
    if (ePrev === undefined || mech >= ePrev || foe) {return 0;}
    if (mech >= 12.5) {return 0;} // still carrying >5m/s — transit, not a deadstop
    return Math.min(8, (ePrev - mech) * 0.08);
  }

  /** Coverage window: under ~30m of real displacement per 5s while the
   *  brain claims a destination reads as sheeping even when the
   *  per-tick speed check squeaks by. `atMs` lets test hooks drive the
   *  window on explicit sim time. */
  coverageDebit(id: string, pos: SheepVec, hasDest: boolean, atMs = this.simMs): number {
    let w = this.cov.get(id);
    if (!w) { w = { start: atMs, dist: 0, lx: pos.x, ly: pos.y, lz: pos.z }; this.cov.set(id, w); }
    // 3D displacement — XZ-only reads a body grinding up a steep
    // slope (half of every T2 port) as covering no ground.
    w.dist += Math.hypot(pos.x - w.lx, pos.y - w.ly, pos.z - w.lz);
    w.lx = pos.x; w.ly = pos.y; w.lz = pos.z;
    if (atMs - w.start < 5000) {return 0;}
    const owed = hasDest && w.dist < 30 ? 20 : 0;
    w.start = atMs; w.dist = 0;
    return owed;
  }

  private ledger(id: string): SheepWhy {
    let w = this.why.get(id);
    if (!w) { w = { idle: 0, ignore: 0, bleed: 0, cover: 0 }; this.why.set(id, w); }
    return w;
  }
}
