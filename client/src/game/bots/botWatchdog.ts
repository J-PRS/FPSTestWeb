import * as THREE from 'three';
import type { GameBot } from './botBrain.js';

type WatchBot = Pick<GameBot, 'playerId' | 'position' | 'isDead' | 'model'>;
type WatchLog = { warn(m: string): void; info(m: string): void };

const WD_DT = 4;        // seconds between logic/render diff samples
const WD_STUCK_T = 10;  // seconds per displacement window
const WD_STUCK_D = 10;  // meters of net travel expected

const _wdPos = new THREE.Vector3();

/** Bot-liveness watchdog. Every WD_DT the samples diff each bot's LOGICAL
 *  position against where the rendered model actually is:
 *    - logic moved but model didn't → tick/interp stall (frozen statue)
 *    - NOTHING moved, all alive bots → brains aren't running at all
 *  Warns once per episode per bot (recovers → re-arms). Match-over and
 *  all-dead windows are legit stillness, not failures. */
export class BotWatchdog {
  constructor(
    private log: WatchLog,
    private matchOver: () => boolean,
  ) {}

  private t = 0;
  private readonly logic = new Map<string, THREE.Vector3>();
  private readonly render = new Map<string, THREE.Vector3>();
  private readonly stalled = new Set<string>();
  // Displacement anchor — where the bot stood ~WD_STUCK_T ago. A bot
  // stuck in a corner keeps producing WD_DT motion deltas (jiggle,
  // repulsion pushback), so the stall test is NET displacement over a
  // longer window: pacing in a 3m circle cancels out, real travel doesn't.
  private readonly anchor = new Map<string, { p: THREE.Vector3; t: number }>();
  private readonly stuck = new Set<string>();
  private idleWindows = 0;

  /** Jersey swap — samples migrate so the same body keeps its
   *  displacement anchor/warn state instead of restarting windows
   *  and leaving a dead-id entry behind. */
  rekey(oldId: string, newId: string): void {
    for (const m of [this.logic, this.render] as const) {
      const v = m.get(oldId);
      m.delete(oldId);
      if (v !== undefined) {m.set(newId, v);}
    }
    const a = this.anchor.get(oldId);
    this.anchor.delete(oldId);
    if (a !== undefined) {this.anchor.set(newId, a);}
    for (const s of [this.stalled, this.stuck] as const) {
      if (s.delete(oldId)) {s.add(newId);}
    }
  }

  step(dt: number, bots: Iterable<WatchBot>): void {
    // A hidden-tab stall lands as one giant frame — counting it as its
    // real span closes travel windows over positions that never ticked,
    // so every bot reads "stuck" on resume. Clamp to one interval.
    this.t += Math.min(dt, WD_DT);
    if (this.t < WD_DT) {return;}
    this.t = 0;
    let alive = 0, stuckNow = 0, stuckEval = 0;
    for (const bot of bots) {
      if (bot.isDead) {continue;}
alive += 1;
      const prev = this.logic.get(bot.playerId);
      const logicD = prev ? prev.distanceTo(bot.position) : 99;
      if (prev) {prev.copy(bot.position);} else {this.logic.set(bot.playerId, bot.position.clone());}

      const evald = this.checkDisplacement(bot);
      if (evald === 'stuck') {stuckEval += 1;stuckNow += 1; }
      else if (evald === 'ok') {stuckEval += 1;}

      this.checkRender(bot, logicD);
    }
    // Whole-squad freeze: every bot that finished a displacement window
    // this tick came up stuck. Two consecutive all-stuck ticks = brains
    // aren't producing travel at all (not just one wedged path).
    if (stuckEval === 0) {return;} // nobody closed a window — keep the streak
    if (stuckNow === stuckEval && stuckEval >= Math.max(1, alive >> 1) && !this.matchOver()) {
      if ((this.idleWindows += 1) >= 2) {
        this.log.warn(`all ${alive} bots pinned — <${WD_STUCK_D}m net travel per ${WD_STUCK_T}s window (brains not ticking?)`);
        this.idleWindows = 0; // re-arm the counter, not the warning state
      }
    } else {
      this.idleWindows = 0;
    }
  }

  /** One displacement-window verdict: 'stuck' | 'ok' when a window just
   *  closed, 'pending' while still accumulating. */
  private checkDisplacement(bot: WatchBot): 'stuck' | 'ok' | 'pending' {
    const a = this.anchor.get(bot.playerId);
    if (!a) {
      this.anchor.set(bot.playerId, { p: bot.position.clone(), t: 0 });
      return 'pending';
    }
    a.t += WD_DT;
    if (a.t < WD_STUCK_T) {return 'pending';}
    const disp = a.p.distanceTo(bot.position);
    a.p.copy(bot.position);
    a.t = 0;
    if (disp < WD_STUCK_D && !this.matchOver()) {
      if (!this.stuck.has(bot.playerId)) {
        this.stuck.add(bot.playerId);
        this.log.warn(`bot ${bot.playerId} stuck — only ${disp.toFixed(1)}m net travel in ${WD_STUCK_T}s (wedged or brain loop?)`);
      }
      return 'stuck';
    }
    if (this.stuck.delete(bot.playerId)) {
      this.log.info(`bot ${bot.playerId} unstuck — ${disp.toFixed(1)}m net travel`);
    }
    return 'ok';
  }

  /** Render-side leg — model position vs its own last sample. Feet sit
   *  EYE below the logical pos; only the delta matters. */
  private checkRender(bot: WatchBot, logicD: number): void {
    const have = bot.model.getModelPosition(_wdPos);
    if (!have) {return;}
    const rp = this.render.get(bot.playerId);
    if (!rp) {
      this.render.set(bot.playerId, _wdPos.clone());
      return;
    }
    const renderD = rp.distanceTo(_wdPos);
    rp.copy(_wdPos);
    if (logicD > 1.5 && renderD < 0.2 && !this.stalled.has(bot.playerId)) {
      this.stalled.add(bot.playerId);
      this.log.warn(`bot ${bot.playerId} render stalled — logic moved ${logicD.toFixed(1)}m, model moved ${renderD.toFixed(2)}m (tick/interp not running)`);
    } else if (renderD > 0.5 && this.stalled.delete(bot.playerId)) {
      this.log.info(`bot ${bot.playerId} render recovered`);
    }
  }
}
