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

export function wireResync(ctx: NetCtx): void {
  const { deps, networkManager } = ctx;
  let hiddenAt: number | null = null;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      return;
    }
    const hiddenMs = hiddenAt === null ? 0 : performance.now() - hiddenAt;
    hiddenAt = null;
    if (hiddenMs < HIDDEN_RESYNC_MS) return;
    if (deps.world.playbackMode || !networkManager.isConnected()) return;

    // Volatile visuals can't be trusted after the backlog — shells the
    // client fast-forwarded blind and fx queued while the fx clock ran
    // wall-time. Kill them; the fresh gameState/rosters re-seed truth.
    const w = deps.world;
    let dropped = 0;
    w.projectiles = w.projectiles.filter((p) => {
      if (!p.isRemote) return true;
      p.dispose();
      dropped++;
      return false;
    });
    for (const e of w.explosions) { e.dispose(); }
    w.explosions.length = 0;
    for (const i of w.implosions) { i.dead = true; }
    w.implosions.length = 0;

    // A correction arriving now must hard-snap to the echoed state —
    // replaying the journaled inputs of the whole hidden interval is the
    // visible "rewinding" storm.
    networkManager.dropInputJournal();
    networkManager.sendResync();
    deps.logger.warn(`[Resync] hidden ${(hiddenMs / 1000).toFixed(1)}s — dropped ${dropped} remote shells, requested world-state replay`);
  });
}
