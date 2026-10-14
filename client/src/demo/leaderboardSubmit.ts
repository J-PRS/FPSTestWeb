// leaderboardSubmit — one call turns a finished run's DemoFile into a
// ranked row. Serializes (stamps tableHash/runSeed + SECTION_TOKEN),
// attaches the boot-fetched challenge for solo runs, POSTs binary.
// The server gates: format → token sig OR challenge-seed binding +
// spawn-dice parity → stat recompute → ranked.

import { serializeDemo } from './demoWriter.js';
import { getChallenge } from './demoSeed.js';
import type { DemoFile } from './types.js';
import type { Challenge } from '../../../shared/resultToken.ts';

export interface SubmitOutcome {
  ok: boolean;
  verdict: string;
  error?: string;
}

export async function submitToLeaderboard(demo: DemoFile, httpUrl: string): Promise<SubmitOutcome> {
  const chal: Challenge | null = getChallenge();
  const chalParam = chal ? `?chal=${btoa(JSON.stringify(chal))}` : '';
  const r = await fetch(`${httpUrl}/leaderboard/submit${chalParam}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: serializeDemo(demo),
  });
  return (await r.json()) as SubmitOutcome;
}
