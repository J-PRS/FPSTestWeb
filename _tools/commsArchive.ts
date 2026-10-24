// _tools/commsArchive.ts — archive .agents/COMMS.md when it grows past
// the threshold. Append-only: copies the whole file to an archive, then
// replaces the active log with a single pointer line. Never deletes.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const COMMS = '.agents/COMMS.md';
const THRESHOLD = 200;
const IDLE_MS = 30 * 60 * 1000; // 30 min cooldown — don't archive in-flight comms

if (!existsSync(COMMS)) { console.log('no comms file'); process.exit(0); }
const st = statSync(COMMS);
const ageMs = Date.now() - st.mtimeMs;
if (ageMs < IDLE_MS) { console.log(`comms: last write ${Math.round(ageMs / 60000)} min ago (<30) — in flight, skip`); process.exit(0); }

const lines = readFileSync(COMMS, 'utf8').split(/\r?\n/);
if (lines.length <= THRESHOLD) { console.log(`comms: ${lines.length} lines (<=${THRESHOLD}) — nothing to do`); process.exit(0); }

const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const archive = `_docs/comms_archive_${ts}.md`;
mkdirSync(dirname(archive), { recursive: true });
copyFileSync(COMMS, archive);

const header = readFileSync(COMMS, 'utf8').split('## Log (append-only)')[0];
writeFileSync(COMMS, `${header}## Log (append-only)\n\nARCHIVED: see ${archive}\n`, 'utf8');
console.log(`comms: archived ${lines.length} lines -> ${archive}`);