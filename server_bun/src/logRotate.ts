/**
 * logRotate — size-triggered mid-run log rolling. Boot-time rotation
 * (rotateLogs in clientLogs) leaves a long-lived server with forever
 * logs; any appender calls rotateLogIfBig before writing so a hot file
 * rolls mid-run too. Kept import.meta/dir-free so anything can import
 * it (clientLogs itself is not safe outside the server graph).
 */
import { existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const MID_RUN_ROLL_BYTES = 32 * 1024 * 1024;
// Archive cap — rotation bounds the live file but OLD/ grew unbounded,
// so a spamming appender still filled the disk through the roll itself.
const OLD_KEEP = 16;

const p2 = (n: number) => String(n).padStart(2, '0');
const logStamp = (t: Date) =>
  `${t.getFullYear()}_${p2(t.getMonth() + 1)}_${p2(t.getDate())}-${p2(t.getHours())}_${p2(t.getMinutes())}_${p2(t.getSeconds())}`;

/** Rolls `p` to an OLD/ sibling with its mtime stamped in the name when
 *  it passes 32MB. Sync stat is fine: appenders are throttled/windowed.
 *  Never throws — a bad rotate must never block an append. */
export function rotateLogIfBig(p: string): void {
  try {
    if (!existsSync(p) || statSync(p).size === 0 || statSync(p).size <= MID_RUN_ROLL_BYTES) {return;}
    const dir = dirname(p);
    mkdirSync(join(dir, 'OLD'), { recursive: true });
    const oldDir = join(dir, 'OLD');
    mkdirSync(oldDir, { recursive: true });
    // Same-second rolls would collide on the stamped name and renameSync
    // silently clobbers the previous archive — up to 32MB of log history
    // per collision. Bump a suffix until the name is free.
    const stem = join(oldDir, `${basename(p, extname(p))}_${logStamp(statSync(p).mtime)}`);
    let dst = stem + extname(p), n = 1;
    while (existsSync(dst)) {dst = `${stem}_${n++}${extname(p)}`;}
    renameSync(p, dst);
    pruneOld(oldDir);
  } catch { /* rotation must never block an append */ }
}

/** Keep the newest OLD_KEEP archives per directory — mtime order, so a
 *  clock-skewed name can't hide a stale file from eviction. */
function pruneOld(oldDir: string): void {
  try {
    const files = readdirSync(oldDir)
      .map((f) => join(oldDir, f))
      .filter((p) => statSync(p).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const p of files.slice(OLD_KEEP)) {unlinkSync(p);}
  } catch { /* pruning is best-effort like rotation itself */ }
}
