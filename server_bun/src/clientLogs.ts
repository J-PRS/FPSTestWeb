/**
 * clientLogs — client log shipping + log rotation. POST /client-log
 * appends to logs/client.log and fans WARN/ERROR lines out to
 * client_warning.log / client_error.log. rotateLogs() runs at boot so
 * each file always reflects the build that produced it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { logger } from './logger.js';
import { wallNow } from './wallClock.js';
import { rotateLogIfBig } from './logRotate.ts';

export const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');

const p2 = (n: number) => String(n).padStart(2, '0');
const logStamp = (t: Date) =>
  `${t.getFullYear()}_${p2(t.getMonth() + 1)}_${p2(t.getDate())}-${p2(t.getHours())}_${p2(t.getMinutes())}_${p2(t.getSeconds())}`;

const rotateLog = (p: string): void => {
  try {
    if (!existsSync(p) || statSync(p).size === 0) return;
    const dst = join(LOGS_DIR, 'OLD', `${basename(p, extname(p))}_${logStamp(statSync(p).mtime)}${extname(p)}`);
    renameSync(p, dst);
  } catch { /* rotation must never block boot */ }
};

export function rotateLogs(): void {
  try {
    mkdirSync(join(LOGS_DIR, 'OLD'), { recursive: true });
    for (const f of readdirSync(LOGS_DIR)) {
      if (/\.(log|jsonl)$/.test(f)) rotateLog(join(LOGS_DIR, f));
    }
    rotateLog(join(import.meta.dir, '..', 'logs', 'server.log'));
  } catch { /* same */ }
}

export { rotateLogIfBig } from './logRotate.ts';

/** Per-IP append throttle — bodies cap at 512KB each, but nothing else
 *  stopped one caller from filling logs/ at line speed. 20 posts/min is
 *  generous for a browser that ships a handful of warns per session. */
const postIps = new Map<string, { count: number; start: number }>();
const POST_IP_LIMIT = 20;
const POST_IP_WINDOW_MS = 60_000;
function postThrottleAllow(ip: string): boolean {
  if (ip === '' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const now = wallNow();
  let w = postIps.get(ip);
  if (!w || now - w.start >= POST_IP_WINDOW_MS) {
    w = { count: 0, start: now };
    postIps.set(ip, w);
    // Wholesale clear() here would reset the window for every live IP —
    // under a churn attack that's a throttle amnesty. Evict eldest first.
    if (postIps.size > 1024) postIps.delete(postIps.keys().next().value!);
  }
  return ++w.count <= POST_IP_LIMIT;
}

// Bodies are plain text lines (WARN/ERROR only by client convention).
export async function clientLogRoute(req: Request, cors: (body: BodyInit | null, init?: ResponseInit) => Response, ip = ''): Promise<Response> {
  try {
    if (!postThrottleAllow(ip)) return cors('Too many posts', { status: 429 });
    const body = await req.text();
    if (body.length > 512 * 1024) {
      return cors('Too large', { status: 413 });
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    // Boot-time rotate leaves a long-lived server with one forever log —
    // roll it mid-run too. statSync per post is fine: posts are IP-throttled.
    const logPath = join(LOGS_DIR, 'client.log');
    rotateLogIfBig(logPath);
    appendFileSync(logPath, body);
    const warnLines: string[] = [];
    const errLines: string[] = [];
    for (const line of body.split('\n')) {
      if (!line) continue;
      if (line.includes('[ERROR]')) errLines.push(line);
      else if (line.includes('[WARN]')) warnLines.push(line);
    }
    if (warnLines.length) {
      const warnPath = join(LOGS_DIR, 'client_warning.log');
      rotateLogIfBig(warnPath);
      appendFileSync(warnPath, warnLines.join('\n') + '\n');
    }
    if (errLines.length) {
      const errPath = join(LOGS_DIR, 'client_error.log');
      rotateLogIfBig(errPath);
      appendFileSync(errPath, errLines.join('\n') + '\n');
    }
    return cors('ok');
  } catch (e) {
    logger.warn('Client log append failed', { error: (e as Error).message });
    return cors('append failed', { status: 500 });
  }
}
