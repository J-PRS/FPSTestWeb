/** Match-results shipping: the client-side half of logs/results/. On
 *  match end or page unload (F5) the local game's outcome - scores,
 *  roster, bot skill/econ surfaces - POSTs to /results so offline and
 *  localhost matches pile into the same balance ledger the server
 *  writes for hosted rooms. Fire-and-forget: a dead/unreachable server
 *  costs one dropped report, never a frame. */

interface WorldResultShape {
  room?: string; mode?: string; mapName?: string;
  ffaScores?: Map<string, number>;
  remotePlayers?: Map<string, { isBot?: boolean; armorClass?: string; skill?: unknown }>;
}

export function shipMatchResult(world: WorldResultShape, local: { kills?: number; deaths?: number; team?: string; armorClass?: string } | undefined, reason: string): void {
  try {
    const players: { id: string; bot: boolean | undefined; team?: string; armorClass: string | undefined; skill?: unknown; kills: number; deaths: number; health: number; maxHealth: number }[] =
      [...(world.remotePlayers?.entries() ?? [])].map(([id, p]) => ({
        id, bot: p.isBot, armorClass: p.armorClass, skill: p.skill,
        kills: 0, deaths: 0, health: 0, maxHealth: 0,
      }));
    if (local) {
      players.push({ id: 'local', bot: false, team: local.team, armorClass: local.armorClass, kills: local.kills ?? 0, deaths: local.deaths ?? 0, health: 0, maxHealth: 0 });
    }
    const body = JSON.stringify({
      room: world.room ?? 'offline', mode: world.mode, map: world.mapName,
      endedAt: Date.now(), reason,
      scores: world.ffaScores ? Object.fromEntries(world.ffaScores) : undefined,
      players,
    });
    // keepalive survives the unload path - a plain fetch dies with the tab.
    void fetch('/results', { method: 'POST', body, keepalive: true }).catch((): void => undefined);
  } catch { /* results are telemetry - never let them break a frame */ }
}
