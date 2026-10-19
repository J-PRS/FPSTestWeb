/**
 * simreplay — the desync oracle's last mile. Replays a recorded
 * FPS_JOURNAL=<file.ndjson> stream into a fresh RoomMoveSim and names the
 * first hash marker where the replay splits. Deterministic through the
 * journal = the sim held; a split tick + pid context localizes the leak.
 *
 *   bun _tools/simreplay.ts path/to/match.ndjson
 *
 * The journal header carries { map, seed } — the map resolves through the
 * same spec chain a room uses (MapCatalog → spec.terrain → maps/*.bin)
 * so a replay runs on the SAME heightfield bytes the match ran on.
 * Header-less journals replay on a flat 60m field (enough for smoke).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RoomMoveSim } from '../server_bun/src/RoomMoveSim.ts';
import { replayJournal, type JournalEv } from '../server_bun/src/simJournal.ts';
import { MapCatalog } from '../server_bun/src/mapCatalog.ts';
import { BallSim } from '../server_bun/src/BallSim.ts';
import { hmParseBin, type Heightfield } from '../shared/heightfield.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: bun _tools/simreplay.ts <journal.ndjson>');
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const first = JSON.parse(lines[0]!);
const header = 'header' in first ? (first.header as { map?: string; seed?: number }) : {};
const events = lines.slice(header.map !== undefined || 'header' in first ? 1 : 0).map((l): JournalEv => JSON.parse(l));

const REPO = join(import.meta.dir, '..');
const MAPS = join(REPO, 'maps');

function resolveField(): Heightfield | null {
  const spec = header.map ? new MapCatalog().loadMapSpec(header.map) : undefined;
  const terrain = spec?.terrain;
  const scale = spec?.heightScale ?? 1;
  const wscale = spec?.tileSize;
  const binPath = terrain ? join(MAPS, terrain) : join(REPO, 'server_bun', 'heightmap.bin');
  if (!existsSync(binPath)) { console.warn(`no terrain for map '${header.map}' (${binPath}) — replaying on flat field`); return null; }
  return BallSim.parseHeightmap(new Uint8Array(readFileSync(binPath)), scale, wscale);
}

const field = resolveField() ?? hmParseBin((() => {
  const b = new Uint8Array(8 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 2, true); dv.setUint32(4, 2, true);
  b.fill(60, 8);
  return b;
})());

const sim = new RoomMoveSim(field);
const hashes = events.filter((e): e is Extract<JournalEv, { kind: 'hash' }> => e.kind === 'hash').length;
const split = replayJournal(events, sim, () => sim.journalHash());
const lastT = events.at(-1)?.t ?? 0;
if (split === -1) {
  console.log(`CLEAN: ${events.length} events, ${lastT} ticks, ${hashes} hash markers all match (map=${header.map ?? 'flat'}, seed=${header.seed ?? '-'})`);
} else {
  console.log(`SPLIT at tick ${split}: replayed hash diverged (map=${header.map ?? 'flat'}, seed=${header.seed ?? '-'}) — the desync is between marker ${split - 50} and ${split}`);
  process.exit(1);
}
