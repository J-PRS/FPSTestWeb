import { ChildLogger } from '../core/Logger.js';
import type { ClientMessage } from '../../../shared/protocol.js';

const logger = new ChildLogger('InputStream');

export type MoveInput = { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number };
type MoveRotation = { yaw: number; pitch: number };

/** Change-only input stream for client-side prediction. Every transmitted
 *  input edge lands in a bounded journal so a server correction can rewind
 *  to the echoed state and replay seq > its last consumed inputSeq —
 *  CFWK-style input replay so missed packets converge instead of
 *  re-diverging. */
export class InputStream {
  private lastSentInput = '';
  private inputSeq = 0;
  // Last transmitted input payload + rotation — an inputSync resend
  // re-emits exactly this (the change-only stream's current edge).
  private lastInputState: MoveInput | null = null;
  private lastInputRotation: MoveRotation = { yaw: 0, pitch: 0 };
  private inputJournal: { seq: number; t: number; input: MoveInput }[] = [];
  private static readonly INPUT_JOURNAL_MAX = 128;

  /** Current input sequence — rides inside the binary position frame so
   *  the server can order input edges against position reports. */
  get seq(): number { return this.inputSeq; }

  private journal(seq: number, input: MoveInput): void {
    this.inputJournal.push({ seq, t: performance.now(), input: { ...input } });
    if (this.inputJournal.length > InputStream.INPUT_JOURNAL_MAX) {this.inputJournal.shift();}
  }

  sendMove(input: MoveInput, rotation: MoveRotation, send: (m: ClientMessage) => void): void {
    const key = `${input.forward},${input.right},${input.jump},${input.ski},${input.jet ?? 0},${input.status ?? 0}`;
    if (key === this.lastSentInput) {return;}
    this.lastSentInput = key;
    // Change-only stream → unordered transports can deliver stale events
    // after fresh ones; the seq lets the server drop them.
    const seq = ++this.inputSeq;
    this.journal(seq, input);
    this.lastInputState = { ...input };
    this.lastInputRotation = { ...rotation };
    send({ type: 'inputMove', seq, input, rotation });
  }

  /** Hard-tolerance answer: the server's consumed input watermark fell
   *  behind ours across several reports — an edge died in flight. Re-emit
   *  the current input with a fresh seq so the shadow converges. */
  resend(lastSeq: number, send: (m: ClientMessage) => void, connected: boolean): void {
    if (!this.lastInputState || !connected) {return;}
    const seq = ++this.inputSeq;
    this.journal(seq, this.lastInputState);
    logger.info(`inputSync: re-emitting input at seq ${seq} (server consumed ${lastSeq})`);
    send({ type: 'inputMove', seq, input: { ...this.lastInputState }, rotation: this.lastInputRotation });
  }

  /** Journal entries with seq > `after` — what the server hadn't consumed
   *  when it issued a correction. Also prunes consumed entries. */
  inputsAfter(after: number): { t: number; input: MoveInput }[] {
    while (this.inputJournal.length > 0 && this.inputJournal[0].seq <= after) {this.inputJournal.shift();}
    return this.inputJournal;
  }

  dropJournal(): void {
    this.inputJournal.length = 0;
  }
}
