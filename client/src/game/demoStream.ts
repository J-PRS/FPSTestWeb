/** Demo stream: the rolling recorder ships 10s slices to the local
 *  server as it runs — crash-safe by construction (each POST lands a
 *  complete playable .demo on disk), no 64KB keepalive cliff at F5.
 *  A match end cuts the session so files group per game:
 *  stream_<session>_<seq>.demo. */

import type { DemoManager } from '../demo/DemoManager.js';
import { DemoSerializer } from '../demo/DemoSerializer.js';

const SLICE_MS = 10_000;

let mgr: DemoManager | null = null;
let session = `g${Date.now().toString(36)}`;
let seq = 0;
let mark = 0; // recorder-time of the last shipped slice
let timer: ReturnType<typeof setInterval> | null = null;

function postSlice(endTime: number, keepalive = false): void {
  const m = mgr;
  if (!m || !m.coolShotMgr.serverUrl || endTime - mark < 0.5) {return;}
  const clip = m.recorder.extractClip(mark, endTime, `stream:${session}`);
  if (!clip) {return;}
  const body = DemoSerializer.serialize(clip);
  void fetch(`${m.coolShotMgr.serverUrl}/demos/stream?session=${session}&seq=${seq}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body, keepalive,
  }).catch((): void => undefined);
  seq += 1;
  mark = endTime;
}

function tick(): void {
  if (!mgr || mgr.mode !== 'recording') {return;}
  postSlice(mgr.recorder.elapsedTime);
}

/** Arm the pump once demoManager exists; it idles when not recording. */
export function startDemoStream(m: DemoManager): void {
  mgr = m;
  timer ??= setInterval(tick, SLICE_MS);
}

/** Match boundary: flush the tail slice, then mint a fresh session so
 *  the next game's chunks land in new files. */
export function cutDemoStream(): void {
  if (mgr && mgr.mode === 'recording') {postSlice(mgr.recorder.elapsedTime);}
  session = `g${Date.now().toString(36)}`;
  seq = 0;
  // The new recorder buffer starts at 0s - mark tracks recorder-time,
  // not wall-time, so a reset also zeroes the slice cursor.
  mark = 0;
}

/** F5/tab-close: last slice goes keepalive - small by construction. */
export function flushDemoStreamOnUnload(): void {
  if (mgr && mgr.mode === 'recording') {postSlice(mgr.recorder.elapsedTime, true);}
}
