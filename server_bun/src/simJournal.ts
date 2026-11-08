/** simJournal — the moveSim-seam recorder (GGPO journal half).
 *  Every call that can move sim state — track/untrack/input edges,
 *  impulses, resyncs, reports, energy grants/drains, water — lands in
 *  the journal with the tick index it applied on, plus a state hash
 *  marker every HASH_EVERY ticks. When a desync escapes the wire-hash
 *  canaries, the match's inputs are already recorded: replayJournal
 *  drives a fresh sim with the same call stream and names the tick the
 *  hash first splits — the Factorio-style forensic.
 *  Events use `t` = completed-tick count: "happened after t ticks,
 *  before tick t+1". Hash markers use `t` = ticks run when emitted.
 *  Named SimJournal to stay distinct from matchJournal.ts — that one
 *  is the match-END scoreboard history. */
import type { Vec3Like } from '../../shared/movement.ts';
import type { MoveInput } from '../../shared/movement.ts';
import type { RoomMoveSim } from './RoomMoveSim.ts';

// File append resolves lazily via dynamic import — this module reaches
// the browser bundle via the P2P host's RoomMoveSim import, where
// node:fs is a stub whose property access throws. NOTE: globalThis.require
// is undefined under Bun ESM, so require-style probes never resolve.
type FsAppend = (p: string, s: string) => void;
let fsAppend: FsAppend | undefined;
const fsReady: Promise<void> = import('node:fs').then((m): void => {
  if (typeof m.appendFileSync === 'function') {fsAppend = m.appendFileSync;}
}).catch((): void => { /* browser bundle — no fs, journal stays memory-only */ });

export const JOURNAL_HASH_EVERY = 50;

export type JournalEv =
  | { t: number; kind: 'track'; pid: string; pos: Vec3Like; yaw: number; perk?: string; team?: string; bot?: boolean; armorClass?: string }
  | { t: number; kind: 'untrack'; pid: string }
  | { t: number; kind: 'input'; pid: string; input: Partial<MoveInput>; status: number; seq?: number }
  | { t: number; kind: 'impulse'; pid: string; dv: Vec3Like }
  | { t: number; kind: 'reconcile'; pid: string; pos: Vec3Like; yaw: number; vel?: Vec3Like; seq?: number; rtt?: number }
  | { t: number; kind: 'resync'; pid: string; pos: Vec3Like; yaw: number; fullEnergy: boolean }
  | { t: number; kind: 'energy'; pid: string; amount: number; drain: boolean }
  | { t: number; kind: 'face'; pid: string; yaw: number }
  | { t: number; kind: 'water'; level?: number }
  | { t: number; kind: 'killY'; level?: number }
  | { t: number; kind: 'hash'; h: number };

/** Omit doesn't distribute member-wise over a union — this does. */
export type JournalEvNoT = JournalEv extends infer E ? E extends JournalEv ? Omit<E, 't'> : never : never;

export class SimJournal {
  readonly events: JournalEv[] = [];
  /** Header the replay needs to rebuild the room — map name + roster
   *  seed written by the Room when it attaches the journal. */
  header: { map?: string; seed?: number } = {};
  private file?: string;
  /** Events that landed before node:fs resolved — flushed once fsReady.
   *  Bounded: a browser host never sets file, so this only ever holds
   *  the import-resolution window (a few ticks), but cap regardless. */
  private pending: string[] = [];
  private static PENDING_MAX = 4096;

  /** NDJSON file target — env-gated at the Room (FPS_JOURNAL). Appends
   *  per event; the rate is forensic-tool scale, not hot-path scale. */
  attachFile(path: string): void {
    this.file = path;
    this.write(`${JSON.stringify({ header: this.header })}\n`);
    void fsReady.then((): void => {
      if (!fsAppend || !this.file) {this.pending = []; return;}
      for (const s of this.pending) {fsAppend(this.file, s);}
      this.pending = [];
    });
  }

  private write(s: string): void {
    if (!this.file) {return;}
    if (fsAppend) {fsAppend(this.file, s);}
    else if (this.pending.length < SimJournal.PENDING_MAX) {this.pending.push(s);}
  }

  push(ev: JournalEv): void {
    this.events.push(ev);
    this.write(`${JSON.stringify(ev)}\n`);
  }

  toNDJSON(): string {
    return `${JSON.stringify({ header: this.header })}\n${this.events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  }
}

/** Replay a journaled call stream into a fresh sim, comparing hash
 *  markers as they land. Returns the first marker tick whose replayed
 *  hash differs (or -1 = deterministic through the whole journal). */
export function replayJournal(events: JournalEv[], sim: RoomMoveSim, hashFn: () => number, dt = 0.05): number {
  let t = 0;
  for (const ev of events) {
    while (t < ev.t) {sim.tick(dt); t += 1;}
    if (applyJournalEv(sim, ev, hashFn)) {return t;}
  }
  return -1;
}

/** One journaled verb against the sim. Returns true on a hash mismatch -
 *  the caller stops replay there (t is the divergence tick). */
function applyJournalEv(sim: RoomMoveSim, ev: JournalEv, hashFn: () => number): boolean {
  switch (ev.kind) {
    case 'track': {sim.track(ev.pid, ev.pos, ev.yaw, ev.perk, ev.team, ev.bot, ev.armorClass); return false;}
    case 'untrack': {sim.untrack(ev.pid); return false;}
    case 'input': {sim.setInput(ev.pid, ev.input, ev.status, ev.seq); return false;}
    case 'impulse': {sim.applyImpulse(ev.pid, ev.dv); return false;}
    case 'resync': {sim.resync(ev.pid, ev.pos, ev.yaw, ev.fullEnergy); return false;}
    case 'reconcile': {sim.reconcile(ev.pid, ev.pos, ev.yaw, ev.vel, ev.seq, ev.rtt); return false;}
    case 'energy': {
      if (ev.drain) {sim.drainEnergy(ev.pid, ev.amount);}
      else {sim.grantEnergy(ev.pid, ev.amount);}
      return false;
    }
    case 'face': {sim.faceYaw(ev.pid, ev.yaw); return false;}
    case 'water': {sim.setWaterLevel(ev.level); return false;}
    case 'hash': {return hashFn() !== ev.h;}
    default: {return false;}
  }
}
