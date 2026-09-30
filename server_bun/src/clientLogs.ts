/**
 * clientLogs — client log shipping + log rotation. POST /client-log
 * appends to logs/client.log and fans WARN/ERROR lines out to
 * client_warning.log / client_error.log. rotateLogs() runs at boot so
 * each file always reflects the build that produced it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { logger } from './logger.js';

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

// Bodies are plain text lines (WARN/ERROR only by client convention).
export async function clientLogRoute(req: Request, cors: (body: BodyInit | null, init?: ResponseInit) => Response): Promise<Response> {
  try {
    const body = await req.text();
    if (body.length > 512 * 1024) {
      return cors('Too large', { status: 413 });
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, 'client.log'), body);
    const warnLines: string[] = [];
    const errLines: string[] = [];
    for (const line of body.split('\n')) {
      if (!line) continue;
      if (line.includes('[ERROR]')) errLines.push(line);
      else if (line.includes('[WARN]')) warnLines.push(line);
    }
    if (warnLines.length) appendFileSync(join(LOGS_DIR, 'client_warning.log'), warnLines.join('\n') + '\n');
    if (errLines.length) appendFileSync(join(LOGS_DIR, 'client_error.log'), errLines.join('\n') + '\n');
    return cors('ok');
  } catch (e) {
    logger.warn('Client log append failed', { error: (e as Error).message });
    return cors('append failed', { status: 500 });
  }
}
