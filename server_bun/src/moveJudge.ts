/**
 * MoveJudge — compares client position reports against the shadow sim.
 * Honest drift tops out ~15m steady; corrections resync the client (not
 * the sim), and N teleport-scale gaps inside a window fire the cheat
 * hook. Split out of RoomMoveSim so the shadow bookkeeping (track/energy/
 * input journal) stays separate from the verdict logic.
 */
import { MoveSim, ENERGY, type MoveInput, type MoveState, type SimSnapshot, type Vec3Like } from '../../shared/movement.ts';
import { FieldSurface } from '../../shared/fieldSurface.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import { wallNow } from './wallClock.ts';

export { FieldSurface };

export interface Shadow {
  sim: MoveSim;
  /** Server-driven bot — its sim grounds on the chord surface (the
   *  rendered mesh), not the smooth field clients predict against. */
  bot?: boolean;
  /** Scratch sim for seq-anchored compares — stepped ahead by the inputs
   *  the report reflects but the shadow hasn't consumed yet. */
  probe?: MoveSim;
  divergences: number;
  /** Timestamps of teleport-scale divergences in the rolling window —
   *  honest drift tops out ~15m, so repeated >SEVERE_M gaps mean a
   *  client reporting positions its own inputs can't produce. */
  severeT: number[];
  /** Fired once — kick isn't retried every report while teardown runs. */
  cheated: boolean;
  /** Spawn seed is the server's guess — the first position report snaps the
   *  sim to the client's actual landing spot instead of flagging it. */
  seeded: boolean;
  /** Corrections throttle — a client fighting the snap reports divergent
   *  positions every tick; one correction per window is enough. */
  lastCorrection: number;
  /** Last server-applied impulse — a knocked client's report and shadow
   *  apply the shove at different sim phases, so mid-arc reads diverge
   *  ~40m for ~2s without anyone cheating. */
  lastImpulseAt: number;
  /** Last judged report position — the report-to-report step is the
   *  teleport signal: a forge shows the REPORT jumping (production's
   *  plausible() gate already rejects these upstream), while an honest
   *  drift shows a normal step beside a stuck shadow. */
  lastRepPos: Vec3Like | null;
  // ---- Energy model ---------------------------------------------------
  // The wire `jet` bit is a claim the tank has fuel; the sim must model
  // the same economy or infinite-jet claims read as valid trajectories.
  // Skill drains (cloak/shield/mend) and activation antes are inferred
  // from the status bits the client already sends on inputMove.
  energy: number;
  jetDrain: number;   // perk multipliers — declared at join
  jetRegen: number;
  energyRegen: number;
  /** Pool-size perk multiplier (airtank = 1.5). */
  energyMax: number;
  /** Raw claimed jet bit — the sim sees it gated by modeled energy. */
  jetWanted: boolean;
  /** Sputter lock — tanks that hit zero refuse jets briefly (T2 rule,
   *  modeled client-side too so replayed trajectories line up). */
  jetLockT: number;
  /** Sum of active per-second skill drains from claimed status bits. */
  skillDrainPerSec: number;
  /** Cloak/shield/mend all suppress the tank recharge client-side too. */
  skillSuppressRegen: boolean;
  /** For ante deduction on 0→1 bit transitions. */
  lastStatus: number;
  /** inputMove ordering — change-only events on unordered transports
   *  (RTC/WT datagrams) can land out of order; regressions are dropped. */
  lastInputSeq: number;
  /** Sim state per consumed input seq, stamped with the sim tick it was
   *  captured at. A report stamped seq N behind the shadow's consumed seq
   *  must compare against the journal entry at N replayed to now — the
   *  live sim applied inputs the report predates (e.g. a jump), which
   *  reads as a divergence otherwise. Insertion-ordered; bounded. */
  seqStates: Map<number, { snap: SimSnapshot; tick: number; inp: MoveInput; e: number }>;
  /** Number of 1/30 sim quanta the shadow has integrated. */
  simTicks: number;
  /** EMA of uplink transit (rttMs/2 from position reports) — how stale
   *  the shadow's input stream is. Feeds the broadcast lead so
   *  observers aim at client-now, not client-transit-ago. */
  transitEma: number;
  /** Raw per-channel estimates behind transitEma: client-reported
   *  (position-frame rttMs) and server-measured (ping/pong echo). The
   *  effective value is min(client, server+slack) — a forged ping
   *  can't buy tolerance since it must fool BOTH channels. */
  clientTransitEma: number;
  serverTransitEma: number;
  /** EMA of |sample − transitEma| on the active channel — link jitter.
   *  The correction lead scales DOWN as variance rises: the EMA is the
   *  best guess for a stable link, but on a jittery one the snap
   *  overshoots as often as undershoots. */
  transitVar: number;
  /** EMA of |inter-report dt − reportEma| — report-arrival jitter, the
   *  link-stability signal that's always populated (reported ping can be
   *  constant on a jittery link). */
  reportVar: number;
  /** Input seq consumed at the last resync() — reports stamped at or below
   *  it are provably pre-respawn/pre-teleport traffic still in flight; the
   *  journal was cleared so they have no anchor to compare against and
   *  would read the discarded trajectory as a blow-through divergence. */
  resyncSeq: number;
  /** Wall time of the last resync(). Reports for ~1 RTT after it are
   *  causally pre-respawn — the respawn message is still in flight to
   *  them so they honestly report the corpse position with fresh seqs
   *  the stale-epoch check can't catch. */
  resyncAt: number;
  /** Step-count residue — simTicks counts MoveSim.STEP quanta; the
   *  fraction of a step dt didn't complete carries into the next tick. */
  acc: number;
  /** Command queue: inputMove edges waiting for the next tick's phase-0
   *  drain, applied in seq order across the tick window. A FIFO, not a
   *  slot — the client replays EVERY journaled edge on correction, so a
   *  co-tick edge the server drops is a guaranteed divergence (tap-jump
   *  under autoHop's hold-to-jump can never exist in a one-slot world).
   *  Bounded: a spam burst drops the oldest edge, not the newest. */
  pending: { input: Partial<MoveInput>; status: number; seq?: number }[];
  /** Consecutive reports whose inputSeq outran our consumed watermark —
   *  a transient gap is just queue latency; a sustained one is a lost
   *  input edge (hard-tolerance trip). */
  gapStreak: number;
  /** Wall time the current gapStreak began — strike banking resumes
   *  once an uncovered gap outlives INPUT_GAP_DEFER_MS (corrections
   *  never stop; only divergences/severe hits defer). */
  gapAt: number;
  /** Wall time the streak last closed + how long it had run — the
   *  catch-up report that closes a gap is the one the free-run deficit
   *  mostly explains, so the severe credit outlives the streak (see
   *  GAP_CLOSED_GRACE_MS). */
  gapClosedAt: number;
  gapRunMs: number;
  /** Consecutive reports deferred by the pending-coverage gate. Sparse
   *  edges defer one report while the producing inputMove sits parked;
   *  a client streaming edges faster than reports stamps every report
   *  at the moving frontier, and an unbounded defer there starves
   *  corrections entirely — the streak caps the wait, then we judge. */
  deferStreak: number;
  /** Cooldown on the inputSync hint so one dead lane can't spam it. */
  lastHintAt: number;
  /** Wall time of the last position report — a throttled client reports
   *  (and sims) slower than the server tick. */
  lastReportAt: number;
  /** EMA of report inter-arrival ms. Reports flow one per client frame,
   *  so below ~4fps the shared MoveSim's MAX_DT clamp makes the client's
   *  sim advance at reportHz × 0.25 of wall time — the cadence is the
   *  only honest proxy for its sim rate the wire already carries. */
  reportEma: number;
}

/** Cap on the transit estimate — a lying ping over-leads the broadcast,
 *  so bound it like REPORT_VEL_CAP bounds claimed velocity. */
export const TRANSIT_EMA_CAP_MS = 300;

export interface JudgeHost {
  /** Judge mode tolerates prediction noise; authority mode is truth —
   *  the client needs tight, frequent acks or its prediction drifts for real. */
  authoritative(): boolean;
  /** Judge tolerance sits above the systematic offset a different-rate
   *  predictor produces (server steps 30Hz; clients step at frame rate —
   *  live soaks measure honest 20Hz clients drifting up to ~15m steady,
   *  a 60Hz human drifts less). Real cheats diverge by orders of
   *  magnitude more — 60m+ reads teleport. */
  divergenceM(): number;
  correctMs(): number;
  /** Room heartbeat map — the judge counts corrections + worst gap here
   *  so 'Room health' lines show rubberbanding pressure, not just logs. */
  health(): Map<string, number> | undefined;
  /** Fires when a shadow accumulates SEVERE_N teleport-scale divergences
   *  inside SEVERE_MS — the kick wiring lives at the Room level (this
   *  sim only knows movement truth). */
  onCheat(playerId: string, dist: number, detail?: Record<string, unknown>): void;
  surface(): FieldSurface | null;
}

/** Per-step integration noise scales with speed — a skier at 35m/s
 *  legitimately drifts ~60% farther per tick than a walker, and
 *  contact-timing differences (crest lips) widen it more. Scale the
 *  tolerance so honest speed doesn't produce count=1 warn clips;
 *  real teleports are still an order of magnitude past. */
const SPEED_TOL_REF = 60; // m/s at which tolerance doubles
/** Honest judge-mode drift measured ~15m on live traffic; a 60m gap
 *  between report and input replay is teleport territory. */
const SEVERE_M = 60;
const SEVERE_N = 3;
const SEVERE_MS = 60_000;
/** How long an uncovered input-seq gap is treated as in-flight before
 *  the edge is judged lost: comfortably past the slowest legal input
 *  lane (netbots heartbeat at 400ms) plus a recovery RTT. */
const INPUT_GAP_DEFER_MS = 600;
/** While an input-seq gap is open the shadow replays stale input, so the
 *  honest report↔sim deficit keeps growing at roughly the player's speed.
 *  Severe banking credits that starved-input deficit (gap age × speed,
 *  capped) — a blackout doesn't read as a teleport (the 60–99m warns a
 *  congested-RTC soak produced). Corrections and divergence counting are
 *  unaffected, and a real teleport still clears the bar: it arrives as a
 *  step function while the credit only grows linearly. */
const GAP_SEVERE_CREDIT_S = 2;
/** How long after an input-seq streak closes the gap credit stays alive.
 *  The catch-up report — the one that CLOSES the streak — is the report
 *  the deficit mostly explains: while its frame stream stalled the
 *  shadow free-ran the stale input, so it lands speed×stall-behind
 *  (~99m at ski speed) exactly when the streak drops to zero and the
 *  open-gap credit vanishes. Without the grace that single report banks
 *  a strike, the >severeM no-reseat rule leaves the standing offset in
 *  place, and the same offset banks two more — 64-client soak tremor.
 *  Neither edge is forgeable: the streak opens only on a server-measured
 *  watermark lead and closes only when a report stops leading it, so the
 *  credit is bounded by real starvation (and still capped by GAP_SEVERE_CREDIT_S). */
const GAP_CLOSED_GRACE_MS = 2000;
/** Cap on the self-reported RTT credited as link-transit tolerance — a
 *  forged multi-second ping widens the divergence budget by at most
 *  speed×RTT_CAP/2 (~6m at ski speed), far under the SEVERE_M trip. */
const RTT_TOL_CAP_MS = 300;
/** The wire's 1000 m/s velocity bound is codec generosity — it stops
 *  coordinate-infinity poisoning but a claim past ~200 is still forged
 *  (terminal fall caps at 100; disc+ski momentum tops out ~150). The
 *  judge adopts reported vel into the shadow AND scales lag/transit
 *  tolerance by it, so an unclamped 1000 m/s claim buys ~150m of free
 *  transit tolerance plus ~900m of throttled-client lag tolerance.
 *  Clamping keeps both anchored to plausible motion. */
const REPORT_VEL_CAP = 200;

export class MoveJudge {
  constructor(private host: JudgeHost) {}

  /** The shadow's report phases, in gate order. Each early return in
   *  reconcile used to be an unnamed special case; naming them makes the
   *  lifecycle explicit: every report lands in exactly one phase, and
   *  only 'judge' reads the divergence math. 'gap-young' still judges —
   *  it only suppresses banking (see below). */
  private gatePhase(sh: Shadow, reportInputSeq: number | undefined): 'grace' | 'seed' | 'stale-epoch' | 'parked-defer' | 'gap-young' | 'judge' {
    // Stale in-flight reports after a re-seat (room hop): the old seat
    // kept reporting until the client saw gameState — those frames would
    // seed the fresh shadow at the old position and flag the real spawn
    // landing ~60m away as a cheat. The hop grace mutes them; the first
    // post-gameState report seeds at the true spawn instead.
    if (wallNow() - sh.resyncAt < CONFIG.reportGraceMs) {return 'grace';}
    if (!sh.seeded) {return 'seed';}
    // Stale-epoch reports: the client sent this before it saw the respawn/
    // teleport that reseated the shadow. Judging it against the new anchor
    // flags a phantom blow-through (a guaranteed ~100m spike per respawn).
    if (reportInputSeq !== undefined && reportInputSeq <= sh.resyncSeq) {return 'stale-epoch';}
    if (reportInputSeq !== undefined && reportInputSeq > sh.lastInputSeq) {
      const parked = reportInputSeq <= (sh.pending.length > 0 ? sh.pending[sh.pending.length - 1]!.seq ?? 0 : 0);
      // Journal coverage gate: a report stamped seq N was produced by the
      // input whose seq is N. When that inputMove has arrived but is still
      // parked in the pending slot (drains at the next tick's phase 0), the
      // journal lacks the edge that produced this position — a jet toggle
      // inside the window reads as a phantom ~10-30m climb, so defer one
      // tick; coverage is guaranteed. A report stamped ahead of everything
      // RECEIVED is different: its input is lost (inputSync recovers it)
      // or forged to dodge the journal — judging it raw is the only
      // authority-preserving answer.
      if (parked && sh.deferStreak < 2) {return 'parked-defer';}
      // Uncovered-but-young gap: the producing inputMove is plausibly
      // still in flight — join-burst clients push inputs on a change/
      // heartbeat lane slower than the report cadence (seen: netbots at
      // 30Hz burn gapStreak 3 in ~100ms, well inside their 400ms input
      // heartbeat). Judging still runs (corrections must flow — starving
      // them for the window is what let honest drift crest unboundedly),
      // but nothing is BANKED: divergences/severe strikes wait until the
      // edge is judged lost. A sustained gap past the window resumes
      // banking — a forger can't hold the frontier past it, and the
      // window itself bounds strike starvation.
      if (!parked && sh.gapStreak > 0 && wallNow() - sh.gapAt < INPUT_GAP_DEFER_MS) {return 'gap-young';}
    }
    return 'judge';
  }

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(sh: Shadow, playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number, rttMs?: number): (MoveState & { inputSeq: number }) | null {
    const s = sh.sim.state;
    const reportNow = wallNow();
    // Clamp the claimed velocity before it touches the shadow or the
    // tolerance math (see REPORT_VEL_CAP).
    let velClamped = vel;
    if (vel) {
      const m = Math.hypot(vel.x, vel.y, vel.z);
      if (m > REPORT_VEL_CAP) {
        const k = REPORT_VEL_CAP / m;
        velClamped = { x: vel.x * k, y: vel.y * k, z: vel.z * k };
      }
    }
    if (sh.lastReportAt > 0) {
      const dt = reportNow - sh.lastReportAt;
      if (dt > 0 && dt < 5000) {
        if (sh.reportEma > 0) {sh.reportVar = sh.reportVar * 0.9 + Math.abs(dt - sh.reportEma) * 0.1;}
        sh.reportEma = sh.reportEma === 0 ? dt : sh.reportEma * 0.8 + dt * 0.2;
      }
    }
    sh.lastReportAt = reportNow;
    s.yaw = yaw; // facing is client truth — sim only needs it for input dir
    const phase = this.gatePhase(sh, reportInputSeq);
    if (phase === 'grace') {return null;}
    if (phase === 'seed') {
      sh.seeded = true;
      s.pos = { x: pos.x, y: pos.y, z: pos.z };
      // The guess-run during the mute built momentum the client never
      // had — adopt the reported velocity too or the leftover vel
      // carries the shadow ~10m ahead for one divergence blip.
      if (velClamped) {s.vel = { x: velClamped.x, y: velClamped.y, z: velClamped.z };}
      s.onGround = true;
      sh.seqStates.clear(); // pre-seed journal anchors the discarded guess
      sh.lastRepPos = { x: pos.x, y: pos.y, z: pos.z };
      return null;
    }
    if (phase === 'stale-epoch') {return null;}
    if (velClamped) { s.vel.x = velClamped.x; s.vel.y = velClamped.y; s.vel.z = velClamped.z; }
    // Report-to-report step — tracked on every judged report so a
    // step-function teleport reads as teleport even while the shadow
    // sits elsewhere (drift and forge look identical as report-vs-
    // shadow distance; only the report stream itself separates them).
    const repJump = sh.lastRepPos ? Math.hypot(pos.x - sh.lastRepPos.x, pos.y - sh.lastRepPos.y, pos.z - sh.lastRepPos.z) : 0;
    sh.lastRepPos = { x: pos.x, y: pos.y, z: pos.z };
    if (phase === 'parked-defer') { (sh.deferStreak += 1); return null; }
    if (reportInputSeq === undefined || reportInputSeq <= sh.lastInputSeq) {
      sh.deferStreak = 0;
    }
    const gapYoung = phase === 'gap-young';
    const dx0 = pos.x - s.pos.x, dy0 = pos.y - s.pos.y, dz0 = pos.z - s.pos.z;
    let dist = Math.hypot(dx0, dy0, dz0);
    if (reportInputSeq !== undefined) {
      // The journal replay is an approximation — it can't reproduce
      // server-applied impulses (knockback, energy grants) inside the
      // window. Judging the worst of both comparisons flags honest hits;
      // the judge takes the better of the two — a cheat still reads far
      // from every reference.
      const cmp = this.anchoredCompare(sh, s, reportInputSeq, pos);
      const d = Math.hypot(pos.x - cmp.pos.x, pos.y - cmp.pos.y, pos.z - cmp.pos.z);
      if (d < dist) {dist = d;}
    }
    const speed = Math.hypot(s.vel.x, s.vel.z);
    // A client throttled below ~4fps sims slower than wall time (MAX_DT
    // caps catch-up at 0.25s/frame), so its honest state trails the
    // full-rate shadow by speed×(1−rate) every second — growing until
    // the next correction snaps it. Report cadence is the rate proxy:
    // under 4Hz the client still burns the whole clamp budget each
    // frame, so simRate ≈ fps × 0.25. Forgive up to that accumulated
    // deficit over the correction window; a teleport is still far past.
    const speed3d = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    const simRate = sh.reportEma > 0 ? Math.min(1, 250 / sh.reportEma) : 1;
    const lagTol = speed3d * (1 - simRate) * (this.host.correctMs() / 1000 + 0.25);
    // The report is ~RTT/2 stale when judged — the shadow integrated to
    // now while the snapshot left the client an uplink ago, so even a
    // perfect prediction reads speed×transit off. On a sustained-ping
    // link that systematic band sits over the tight authority tolerance
    // and every report past it re-fires a correction — the rubberband
    // loop. Only the TRANSIT share is credited: upstream jitter past the
    // mean still diverges honestly.
    const transitTol = speed3d * Math.min(Math.max(rttMs ?? 0, 0), RTT_TOL_CAP_MS) / 2000;
    const tol = this.host.divergenceM() * (1 + speed / SPEED_TOL_REF) + lagTol + transitTol;
    if (dist <= tol) {return null;}

    // Young-gap reports get corrected like any over-tolerance drift but
    // bank nothing — the producing input may still be in flight, and a
    // strike counted on a phantom gap is a false positive the client
    // can't defend against. An OPEN gap past the defer window keeps
    // banking divergences but the severe bar scales by the starved-input
    // deficit (see GAP_SEVERE_CREDIT_S).
    const gapCredit = sh.gapStreak > 0
      ? speed3d * Math.min((reportNow - sh.gapAt) / 1000, GAP_SEVERE_CREDIT_S)
      : (reportNow - sh.gapClosedAt < GAP_CLOSED_GRACE_MS
        ? speed3d * Math.min(sh.gapRunMs / 1000, GAP_SEVERE_CREDIT_S)
        : 0);
    const severeM = SEVERE_M + gapCredit;
    if (!gapYoung) {this.noteDivergence(sh, playerId, pos, reportInputSeq, dist, tol, severeM);}
    // Judge mode: the client report is truth (no corrections flow), so a
    // shadow left standing on a stale position measures the SAME offset
    // on every report — one systematic blip (crest timing, transit skew,
    // a knockback event the link dropped) snowballs into teleport-scale
    // strikes on honest play; the soak's 'Movement cheat' warns were
    // exactly this. Reseat when the report's own step is sub-severe —
    // the client's motion stayed continuous and only the shadow is lost.
    // A step-function report (>severeM between reports) never reseats:
    // that split is the teleport evidence itself and the shadow must
    // keep measuring it (documented intent: "over that we resync the
    // sim to the report"). A divergence past the severe bar only reseats
    // inside the impulse window — a shove the wire event never carried
    // is server-caused split, not client evidence. Authority mode keeps
    // sim truth — the correction below is what reconverges that side.
    const postImpulse = sh.lastImpulseAt > 0 && wallNow() - sh.lastImpulseAt < 2000;
    if (!this.host.authoritative() && repJump <= severeM && (dist <= severeM || postImpulse)) {
      s.pos = { x: pos.x, y: pos.y, z: pos.z };
      s.onGround = true;
      // Anchors captured pre-reseat replay over the discarded trajectory
      // and read every next report as phantom divergence.
      sh.seqStates.clear();
    }
    // Snap budget scales with speed: at cruise (~50m/s) a 5m offset is
    // 0.1s of travel — invisible; at standstill even 1.5m reads. The
    // snap ships only past the floor (feel over accuracy); divergences
    // still bank at tol — anti-cheat doesn't get the slack — and the
    // budget is bounded so drift can't grow past it.
    const snapTol = Math.max(tol, Math.max(1.5, speed3d * 0.1));
    if (dist <= snapTol) {return null;}
    const now = wallNow();
    if (now - sh.lastCorrection < this.host.correctMs()) {return null;}
    sh.lastCorrection = now;
    // The sim keeps its own position — resyncing onto the rejected report
    // would make the correction we just sent diverge from the next report
    // and ping-pong forever. Convergence comes from the client snapping.
    // The shadow trails the client by its uplink transit — snapping the
    // client to the raw sim pos bounces it back by that whole gap. The
    // same velocity-linear lead as the broadcast puts the correction
    // where the client actually is, so the snap is a nudge not a teleport.
    // Stability-scaled lead: a clean link gets the full one-way transit
    // (the snap lands where the client will be at consumption); a
    // jittery one falls back toward the conservative half — past the
    // jitter, the EMA overshoots as often as it undershoots.
    const transit = Math.min(Math.max(sh.transitEma, 0), TRANSIT_EMA_CAP_MS);
    const jit = Math.max(
      transit > 0 ? sh.transitVar / transit : 0,
      sh.reportEma > 0 ? sh.reportVar / sh.reportEma : 0,
    );
    const stability = transit > 0 ? Math.max(0.5, 1 - 2 * jit) : 0.5;
    const lead = transit * stability / 1000;
    const truth: MoveState & { inputSeq: number } = {
      pos: { x: s.pos.x + s.vel.x * lead, y: s.pos.y + s.vel.y * lead, z: s.pos.z + s.vel.z * lead },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      yaw, pitch: s.pitch, onGround: s.onGround,
      // Which client input event the sim consumed last — the correction
      // anchor so the client replays only what the server never saw.
      inputSeq: sh.lastInputSeq,
    };
    return truth;
  }

  /** Divergence bookkeeping — counter for future kicks, health metrics,
   *  and the log gate: a single just-over-tolerance clip is a crest-lip
   *  contact-timing gap (the next correction converges it), so WARN only
   *  on repeats or blow-throughs; count=1 marginal clips are the known
   *  noise floor and stay INFO for later review. */
  private noteDivergence(sh: Shadow, playerId: string, pos: Vec3Like, reportInputSeq: number | undefined, dist: number, tol: number, severeM: number): void {
sh.divergences += 1;
    this.noteHealth(dist);
    // The severe counter gets the same grace the log line does: inside
    // the impulse window the journal can't reproduce the shove (see
    // anchoredCompare's own comment), so a >severeM gap is unverifiable
    // knockback skew, not teleport evidence. Without this, three blasts
    // a minute on one honest player banks a guaranteed cheat trip — the
    // nb_57/nb_63 warns the 64-client soak produced on the 5%-loss
    // quartile. Strikes already banked keep decaying on SEVERE_MS; the
    // window just can't add new ones.
    if (wallNow() - sh.lastImpulseAt >= 2000) {
      const s = sh.sim.state;
      this.noteSevere(sh, playerId, dist, severeM, {
        simPos: `${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)}`,
        repPos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
        simVel: `${s.vel.x.toFixed(1)},${s.vel.y.toFixed(1)},${s.vel.z.toFixed(1)}`,
        inp: `${sh.sim.input.forward},${sh.sim.input.right},${sh.sim.input.skiHeld ? 1 : 0},${sh.sim.input.jetHeld ? 1 : 0}`,
        simTicks: sh.simTicks, inSeq: sh.lastInputSeq, repSeq: reportInputSeq,
        gapStreak: sh.gapStreak, impAgo: sh.lastImpulseAt > 0 ? Math.round(wallNow() - sh.lastImpulseAt) : -1,
      });
    }
    // Mid-arc knockback skew is transient by construction — the severe
    // counter no longer banks inside the impulse window (above), but the
    // log line stays informational. Same for permissive mode: without
    // sim authority nothing ever corrects the shadow, so two honest
    // sims drifting on cresty terrain is the expected steady state,
    // not a warn — the plausibility gate is the real judge there.
    const transient = !this.host.authoritative() || dist < tol * 1.5 || wallNow() - sh.lastImpulseAt < 2000;
    if (sh.divergences !== 1 && sh.divergences % 20 !== 0) {return;}
    const s = sh.sim.state;
    logger[transient ? 'info' : 'warn']('Move sim divergence', {
      playerId, dist: dist.toFixed(1), tol: tol.toFixed(1), count: sh.divergences,
      simTicks: sh.simTicks, inSeq: sh.lastInputSeq, repSeq: reportInputSeq,
      inp: `${sh.sim.input.forward},${sh.sim.input.right},${sh.sim.input.skiHeld ? 1 : 0},${sh.sim.input.jetHeld ? 1 : 0}`,
      simPos: `${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)}`,
      repPos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
    });
  }

  private noteHealth(dist: number): void {
    const h = this.host.health();
    if (!h) {return;}
    h.set('diverge', (h.get('diverge') ?? 0) + 1);
    if (dist > (h.get('gapMax') ?? 0)) {h.set('gapMax', Math.round(dist * 10) / 10);}
  }

  /** Rolling severe-blow counter — N overshoots inside the window flags
   *  the shadow as a teleporter, not a drifter. */
  private noteSevere(sh: Shadow, playerId: string, dist: number, severeM: number, detail?: Record<string, unknown>): void {
    if (dist <= severeM || sh.cheated) {return;}
    const now = wallNow();
    sh.severeT = sh.severeT.filter((t): boolean => now - t < SEVERE_MS);
    sh.severeT.push(now);
    if (sh.severeT.length >= SEVERE_N) {
      sh.cheated = true;
      this.host.onCheat(playerId, dist, detail);
    }
  }

  /** Pick the sim state a seq-stamped report should be compared against.
   *  reconcile() guarantees reportSeq ≤ lastInputSeq before this runs —
   *  replay from the journal anchor at/below the report seq up to now:
   *  the live sim applied inputs the report predates, which reads as
   *  divergence otherwise. */
  private anchoredCompare(sh: Shadow, s: MoveState, reportSeq: number, reportPos: Vec3Like): MoveState {
    // Entries after the anchor (sorted) define input segments: each runs
    // its recorded input until the next entry's sim tick — a jet toggle
    // mid-window then replays correctly instead of being applied to the
    // whole span.
    let anchorSeq: number | undefined = undefined;
    const after: { snap: SimSnapshot; tick: number; inp: MoveInput; e: number }[] = [];
    for (const [k, e] of sh.seqStates) {
      if (k <= reportSeq && (anchorSeq === undefined || k > anchorSeq)) {anchorSeq = k;}
      else if (k > reportSeq) {after.push(e);}
    }
    after.sort((x, y): number => x.tick - y.tick);
    const anchor = anchorSeq === undefined ? undefined : sh.seqStates.get(anchorSeq);
    if (!anchor) {return s;}
    sh.probe ??= new MoveSim(this.host.surface()!, anchor.snap.st);
    const {probe} = sh;
    // The probe replays the SAME body — a heavy's weaker jets would
    // replay as a phantom climb if mass/eye fell back to defaults.
    probe.mass = sh.sim.mass; probe.eyeHeight = sh.sim.eyeHeight;
    probe.restore(anchor.snap);
    // The report is a snapshot from one uplink-transit ago — replaying to
    // simTicks overshoots the probe past the report's true comparison
    // point and the excess reads as divergence at speed.
    const targetTick = sh.simTicks - Math.round(sh.transitEma / (MoveSim.STEP * 1000));
    const segs = [...after, { snap: anchor.snap, tick: Math.max(targetTick, anchor.tick), inp: sh.sim.input }];
    // transitEma is an EMA — on a jittery link the report's true age
    // wanders ±tens of ms either side of it, which at speed reads as
    // ±a meter of phantom divergence (and phantom corrections). Judge
    // the report against the BEST alignment inside a ±1-tick window
    // instead of the point estimate: a real divergence doesn't line up
    // anywhere in the window; jitter just picks a different tick. (±2
    // forgave a real post-reseed divergence in the soak.)
    let best: MoveState | null = null;
    let bestD = Infinity;
    this.replayWindow(sh, probe, anchor, segs, (tick): void => {
      if (tick < targetTick - 1) {return;}
      const st = probe.state;
      const d = Math.hypot(reportPos.x - st.pos.x, reportPos.y - st.pos.y, reportPos.z - st.pos.z);
      if (d < bestD) { bestD = d; best = Object.assign({}, st, {pos: Object.assign({}, st.pos),vel: Object.assign({}, st.vel)}); }
    });
    return best ?? probe.state;
  }

  /** Replay the anchor→now input segments through the probe, mirroring
   *  the tank's energy gating. Cap TOTAL replay work, not each segment —
   *  a per-segment cap leaves the probe stale mid-window and reads the
   *  truncation as divergence (journal is ≤32 entries, window is small). */
  private replayWindow(
    sh: Shadow, probe: MoveSim,
    anchor: { snap: SimSnapshot; tick: number; inp: MoveInput; e: number },
    segs: { tick: number; inp: MoveInput }[],
    onStep?: (tick: number) => void,
  ): void {
    let {tick} = anchor;
    let {inp} = anchor;
    let budget = 128;
    // The probe must mirror the tank: the live sim gates jetHeld off when
    // energy drains — replaying raw input keeps the probe jetting where
    // the real sim ran dry (~18m false divergence at spawn jet windows).
    let {e} = anchor;
    let lockT = 0;
    for (const seg of segs) {
      const steps = Math.min(seg.tick - tick, budget);
      if (steps > 0) {
        Object.assign(probe.input, inp);
        for (let i = 0; i < steps; i += 1) {
          if (lockT > 0) {lockT -= MoveSim.STEP;}
          const jetting = inp.jetHeld === true && e > 0 && lockT <= 0;
          probe.input.jetHeld = jetting;
          if (jetting) {e -= ENERGY.jetDrain * sh.jetDrain * MoveSim.STEP;}
          else if (!sh.skillSuppressRegen) {e = Math.min(ENERGY.max * sh.energyMax, e + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * MoveSim.STEP);}
          if (sh.skillDrainPerSec > 0) {e -= sh.skillDrainPerSec * MoveSim.STEP;}
          e = Math.max(0, e);
          if (e <= 0) {lockT = ENERGY.jetLockout;}
          probe.update(MoveSim.STEP);
          onStep?.(tick + i + 1);
        }
        tick += steps;
        budget -= steps;
      }
      if (tick >= sh.simTicks || budget <= 0) {break;}
      ({inp} = seg);
    }
  }

}
