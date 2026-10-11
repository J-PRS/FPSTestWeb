/**
 * recPlayer — replay a .rec wire capture through the live message
 * pipeline so a recorded run (creatureGauntlet --record, pvptest
 * record.ts) plays in-game as real gameplay. Dev-only: reaches the
 * NetworkManager via window.__test and schedules each line at its
 * recorded offset × speed.
 *
 *   __playRec('/hunt.rec')          // fetch + replay at 1x
 *   __playRec('/hunt.rec', 2)       // 2x speed
 *   __playRec(file)                 // File from an <input type=file>
 */
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { ServerMessage } from '../../../shared/protocol.js';

interface RecLine { ms: number; json?: ServerMessage; bin?: Uint8Array }

const hexToBytes = (hex: string): Uint8Array => {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i += 1) {u8[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);}
  return u8;
};

export function parseRec(text: string): RecLine[] {
  const out: RecLine[] = [];
  for (const ln of text.split('\n')) {
    if (!ln) {continue;}
    const t1 = ln.indexOf('\t'), t2 = ln.indexOf('\t', t1 + 1);
    if (t1 === -1 || t2 === -1) {continue;}
    const ms = Number(ln.slice(0, t1));
    const kind = ln.slice(t1 + 1, t2);
    const payload = ln.slice(t2 + 1);
    if (kind === 'json') {out.push({ ms, json: JSON.parse(payload) as ServerMessage });}
    else if (kind === 'bin') {out.push({ ms, bin: hexToBytes(payload) });}
  }
  return out;
}

export function playRecLines(nm: NetworkManager, lines: RecLine[], speed = 1): () => void {
  const timers: number[] = [];
  for (const l of lines) {
    const t = window.setTimeout((): void => {
      nm.replayWireMessage(l.json ?? l.bin!);
    }, l.ms / speed);
    timers.push(t);
  }
  return (): void => { for (const t of timers) {window.clearTimeout(t);} };
}

export async function playRec(nm: NetworkManager, src: string | File, speed = 1): Promise<() => void> {
  const text = typeof src === 'string' ? await (await fetch(src)).text() : await src.text();
  return playRecLines(nm, parseRec(text), speed);
}
