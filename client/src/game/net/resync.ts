// Alt-tab catch-up — a hidden tab throttles rAF to ~1fps while the wire
// keeps delivering in real time, so the backgrounded interval piles up as
// client-side prediction debt (CFWK corrections + stale shells/fx). The
// fix is the player's proposal: don't rewind, refetch. On regain after a
// long hidden stretch we drop the volatile layer locally and ask the
// server to replay the world state (gameState + rosters).

import type { NetCtx } from './ctx.js';

// Below this the normal prediction paths already bridge the gap fine —
// resync is for real alt-tabs, not a quick task switch.
const HIDDEN_RESYNC_MS = 3000;

/** Volatile visuals can't be trusted after a backlog — shells the client
 *  fast-forwarded blind and fx that spawned (and slow-mo decayed at 5%
 *  speed) while the tab was hidden. Kill them; authoritative state
 *  (gameState/rosters/resync reply) re-seeds truth. Local shells stay. */
export function dropVolatileWorldFx(w: { projectiles: { isRemote: boolean; dispose(): void }[]; explosions: { dispose(): void }[]; implosions: { dead: boolean }[] }): number {
  let dropped = 0;
  // Splice in place — the dump/debug ctx captured world.projectiles by
  // reference at wire-up; rebinding the array leaves every such holder
  // reading a frozen list forever (the "0 live" artifact after resync).
  for (let i = w.projectiles.length - 1; i >= 0; i -= 1) {
    const p = w.projectiles[i]!;
    if (!p.isRemote) {continue;}
    p.dispose();
    w.projectiles.splice(i, 1);
dropped += 1;
  }
  for (const e of w.explosions) { e.dispose(); }
  w.explosions.length = 0;
  for (const i of w.implosions) { i.dead = true; }
  w.implosions.length = 0;
  return dropped;
}

export function wireResync(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  let hiddenAt: number | null = null;

  document.addEventListener('visibilitychange', (): void => {
    if (document.hidden) {
      hiddenAt = performance.now();
      return;
    }
    const hiddenMs = hiddenAt === null ? 0 : performance.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs < HIDDEN_RESYNC_MS) {return;}
    if (deps.world.playbackMode) {return;}

    // Purge even while disconnected — the socket often dies during the
    // hidden stretch ("CONNECTION LOST" on return) and gating the purge
    // on isConnected() let the whole backlog survive into reconnect.
    const dropped = dropVolatileWorldFx(deps.world);
    if (!networkManager.isConnected()) {
      deps.logger.warn(`[Resync] hidden ${(hiddenMs / 1000).toFixed(1)}s offline — dropped ${dropped} remote shells`);
      return;
    }

    // A correction arriving now must hard-snap to the echoed state —
    // replaying the journaled inputs of the whole hidden interval is the
    // visible "rewinding" storm.
    networkManager.dropInputJournal();
    networkManager.sendResync();
    deps.logger.warn(`[Resync] hidden ${(hiddenMs / 1000).toFixed(1)}s — dropped ${dropped} remote shells, requested world-state replay`);
  });
}
