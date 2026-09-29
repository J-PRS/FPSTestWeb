/**
 * Soak auditor — one command runs a headless fleet match and prints a
 * combined report: the fleet's client-side verdicts (damage, smoothness,
 * rubberbanding, tick stream) plus what the SERVER logged underneath
 * (warns, mobility/sheep lines, room health, rejects).
 *
 * Usage: bun soakreport.ts [map] [seconds] [botsPerRoom] [rooms]
 *   bun soakreport.ts crossfire 60 4 1
 *   bun soakreport.ts underhold 90 6 2
 * Exits non-zero when any axis fails — CI-able health check.
 */

const MAP = process.argv[2] ?? 'crossfire';
const SECONDS = process.argv[3] ?? '60';
const PER_ROOM = process.argv[4] ?? '4';
const ROOMS = process.argv[5] ?? '1';
let PORT = 8471 + Math.floor(Math.random() * 300);
const SBOTS = process.env.SOAK_SBOTS ?? '6';
const EXTRA = process.argv.filter(a => a.startsWith('--'));

const repo = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const serverDir = `${repo}server_bun`;

console.log(`soakreport: map=${MAP} ${SECONDS}s, ${PER_ROOM} fleet bots × ${ROOMS} rooms + ${SBOTS} server bots, port ${PORT}`);

// Server first — fleet joins need the listener up. We capture stdout
// ourselves: the on-disk sink only records warn+, while the interesting
// health signals (mobility, tick lag, room heartbeats) are INFO.
// Bind can lose to another agent's server — retry on a fresh port until
// the process survives its first second (EADDRINUSE exits immediately).
let server: ReturnType<typeof Bun.spawn> | null = null;
let serverOut: Promise<string> = Promise.resolve('');
for (let attempt = 0; attempt < 5; attempt++) {
  PORT = 8471 + Math.floor(Math.random() * 400);
  const s = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: serverDir,
    env: { ...process.env, FPS_PORT: String(PORT), FPS_MAP: MAP, FPS_SBOTS: SBOTS, LOG_LEVEL: 'info' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const died = await Promise.race([
    s.exited.then(() => true),
    new Promise<boolean>(r => setTimeout(() => r(false), 1500)),
  ]);
  if (!died) {
    server = s;
    serverOut = Promise.all([
      new Response(s.stdout).text(),
      new Response(s.stderr!).text(),
    ]).then(([out, err]) => out + err);
    break;
  }
  console.log(`  port ${PORT} busy — retrying`);
}
if (!server) { console.log('could not bind a server port after 5 tries'); process.exit(1); }
await new Promise(r => setTimeout(r, 1500));

// Fleet — inherit stdout so its SOAK REPORT streams live; we re-scan it
// below for the machine line anyway.
const fleet = Bun.spawn(
  ['bun', 'fleet.ts', `ws://localhost:${PORT}/ws`, 'soak', ROOMS, PER_ROOM, SECONDS, ...EXTRA],
  { cwd: import.meta.dir, env: { ...process.env, FLEET_SBOTS: SBOTS, FLEET_MAP: MAP }, stdout: 'pipe', stderr: 'inherit' },
);
const fleetOut = await new Response(fleet.stdout).text();
process.stdout.write(fleetOut);
const fleetCode = await fleet.exited;

// Server audit — the fleet sees the wire; this sees the inside. Also
// persisted so the full INFO stream survives for later digging.
server.kill();
const log = await serverOut;
const logDir = `${import.meta.dir}/logs`;
await Bun.write(`${logDir}/soak_server.log`, log);
const report: string[] = [];
{
  const lines = log.split('\n');
  const count = (re: RegExp) => lines.filter(l => re.test(l)).length;
  const warns = lines.filter(l => l.includes('[WARN')).slice(-12);
  const errors = lines.filter(l => l.includes('[ERROR')).slice(-12);
  const mobility = lines.filter(l => /Bot mobility|sheep|stuck/i.test(l)).slice(-8);
  const posRejects = count(/Position rejected/i);
  const diverge = count(/divergence/i);
  const shotRejects = lines.filter(l => /Shot rejected|shotRejected/i.test(l) && !/already dead/i.test(l)).length;
  const deploys = count(/Deploy placed/i);
  const botsSpawned = count(/Bots spawned/i);
  const mobilityLines = count(/Bot mobility/i);
  const lagMatch = [...log.matchAll(/tick lag avg ([\d.]+)ms.*max ([\d.]+)ms/g)].pop();

  report.push(`\n=== SERVER LOG AUDIT (saved → ${logDir}/soak_server.log) ===`);
  report.push(`  warns: ${warns.length}`);
  for (const w of warns) report.push(`    ${w.trim()}`);
  report.push(`  errors: ${errors.length}`);
  for (const e of errors) report.push(`    ${e.trim()}`);
  report.push(`  position rejects: ${posRejects}   divergence notices: ${diverge}   shot rejects logged: ${shotRejects}`);
  report.push(`  deploys placed: ${deploys}`);
  report.push(`  server bots: ${botsSpawned} spawn lines, ${mobilityLines} mobility reports${parseInt(SBOTS) > 0 && mobilityLines === 0 ? '  ← EXPECTED MOBILITY, GOT NONE' : ''}`);
  if (lagMatch) report.push(`  tick cost: avg ${lagMatch[1]}ms, max ${lagMatch[2]}ms (50ms budget)`);
  if (mobility.length) { report.push(`  mobility lines (tail):`); for (const m of mobility) report.push(`    ${m.trim()}`); }
}
for (const l of report) console.log(l);
const fails = report.filter(l => /errors: [1-9]|position rejects: [1-9]|GOT NONE/.test(l)).length;
console.log(`\nVERDICT: ${fleetCode === 0 && fails === 0 ? 'CLEAN' : 'ISSUES — see above'} (fleet exit ${fleetCode})`);
process.exit(fleetCode === 0 && fails === 0 ? 0 : 1);
