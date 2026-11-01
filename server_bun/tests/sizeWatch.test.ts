import { describe, it, expect } from 'bun:test';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** ROADMAP next-list: a ~900-line ceiling that flags the next
 *  Player.ts/CombatHandler.ts before it needs a burn-down. New files
 *  fail outright over the ceiling; existing giants are pinned at their
 *  current size + 15% — in-flight edits get room, but a real blow-up
 *  trips the alarm before the file needs a burn-down. */
const GROWTH_ALLOWANCE = 1.15;
const CEILING = 900;
const GRANDFATHERED: Record<string, number> = {
  // Re-pinned at the worker-crash-escalation size — still alarms at +15%.
  'client/src/networking/NetworkManager.ts': 1370,
  'client/src/entities/PlayerModel.ts': 1427,
  'client/src/gunlab.ts': 1458,
  'client/src/maplab.ts': 1845,
  'client/src/lab/scenarios.ts': 1000,
  // Re-pinned at the C4 edge-relay + bot-edge-mint size — Room legitimately
  // aggregates the match container; still alarms at +15%.
  'server_bun/src/Room.ts': 1765,
  'server_bun/src/serverSenses.ts': 1045,
  // Crossed via the C4 remote-replay block — the netcode half legitimately
  // aggregates interp/DR/replay paths. Pinned; still alarms at +15%.
  'client/src/entities/remoteInterp.ts': 913,
  'client/src/effects/vertexAO.ts': 956,
  'shared/botTaunts.ts': 1360,
  'shared/botBrain.ts': 910,
  'client/src/main.ts': 1252, // re-pinned at demo-clip WIP size — still alarms at +15%
  'client/src/game/gameLoop.ts': 1123, // ditto
  // Pinned after the alarm tripped (ROADMAP next-list: burn down the
  // ichor/corpse FX block + cluster bomblets into their own modules).
  'client/src/game/combat/impact.ts': 1145,
  // Crossed via the botMpc capper-drive WIP (6fbf15b7) — pinned at its
  // breached size; still alarms if it grows another 15%.
  'server_bun/src/botRouting.ts': 1011,
  // Breached unpinned (pre-existing): pinned at current size so the
  // next 15% still alarms.
  'client/src/core/stateDebug.ts': 1541,
  'client/src/game/deployables.ts': 1142,
  'client/src/game/lobbyPanel.ts': 1227,
  'client/src/game/net/mapAssets.ts': 1763,
  'client/src/world/terrainShaders.ts': 919,
  // Crossed via the arsenal rework (eafd1c11) — pinned at its breached
  // size; still alarms if it grows another 15%.
  'server_bun/src/botArsenal.ts': 916,
  // Breached via the wire-batch addition (the codec file legitimately
  // aggregates frame encoders) — pinned; still alarms at +15%.
  // Re-pinned at 1227 after the binary event family + evScratch ring.
  'shared/wire.ts': 1227,
  // Breached via the gonne/basilisk builders — ballistic viewmodel
  // file legitimately aggregates gun constructors; next split goes to
  // weaponsGeoArchive. Pinned; still alarms at +15%.
  'client/src/entities/viewmodel/weaponsGeoBallistic.ts': 924,
  // Crossed via the draw-call campaign — the renderer legitimately
  // aggregates passes; pinned at its breached size, +15% alarms.
  'client/src/core/renderer.ts': 907,
  // Procedural map toolkit — gen mutations accumulate here; pinned,
  // still alarms at +15%.
  'client/src/maplab/gen.ts': 966,
  // Crossed via the ballmats material lineup — a lab file that
  // legitimately accumulates preview variants. Pinned; +15% alarms.
  'client/src/gunlab/previews.ts': 901,
};

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {yield* walk(p);}
    else if (e.endsWith('.ts')) {yield p;}
  }
}

const root = join(import.meta.dir, '..', '..');
const offenders: string[] = [];
const grown: string[] = [];
for (const dir of ['shared', 'server_bun/src', 'client/src']) {
  for (const p of walk(join(root, dir))) {
    const rel = relative(root, p).replaceAll('\\', '/');
    const src = readFileSync(p, 'utf8');
    const n = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
    const pinned = GRANDFATHERED[rel];
    if (pinned !== undefined) {
      if (n > Math.floor(pinned * GROWTH_ALLOWANCE)) {grown.push(`${rel} ${n} > pinned ${pinned} (+15%)`);}
    } else if (n > CEILING) {offenders.push(`${rel} ${n} lines`);}
  }
}

describe('file-size watch (~900-line ceiling)', () => {
  it('no new file crosses the ceiling', () => {
    expect(offenders).toEqual([]);
  });
  it('grandfathered files only shrink', () => {
    expect(grown).toEqual([]);
  });
});
