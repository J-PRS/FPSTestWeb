export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel;
  private readonly startTime: number;
  private logFile: string | null = null;

  constructor(level: LogLevel = 'info') {
    this.level = level;
    this.startTime = performance.now();
    // File sink — warn+ always land on disk so degraded behavior is
    // observable after the fact, not just in a live console. Bun-only:
    // browser hosts (P2P embeds of PlayerManager/CombatHandler) have no
    // fs, so resolve it through require at construction and stay quiet
    // if it isn't there.
    try {
      const g = globalThis as { Bun?: unknown; require?: (m: string) => { appendFileSync(p: string, s: string): void; mkdirSync(p: string, o?: { recursive: boolean }): void } };
      if (!g.Bun) {return;}
      // globalThis.require (not bare `require`) keeps this file valid in
      // the browser tsconfig that typechecks server modules for P2P embeds.
      const fs = g.require?.('node:fs');
      if (!fs) {return;}
      fs.mkdirSync('logs', { recursive: true });
      this.logFile = 'logs/server.log';
      this.append = (line): void => fs.appendFileSync(this.logFile!, `${line  }\n`);
    } catch { /* console-only */ }
  }

  private append: ((line: string) => void) | null = null;

  private toFile(line: string): void {
    try { this.append?.(line); } catch { /* a bad disk write must never take a tick down */ }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  /** Cheap public probe so hot paths can skip building args the level
   *  would discard — logger.debug(msg, obj) still evaluates `obj`. */
  enabled(level: LogLevel): boolean {
    return this.shouldLog(level);
  }

  private format(level: LogLevel, msg: string, data?: unknown): string {
    const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(3);
    const prefix = `[${elapsed.padStart(8, ' ')}s] [${level.toUpperCase().padEnd(5, ' ')}]`;
    if (data !== undefined) {
      return `${prefix} ${msg} ${this.stringify(data)}`;
    }
    return `${prefix} ${msg}`;
  }

  private stringify(data: unknown): string {
    try {
      if (data instanceof Error) {
        return `${data.message}\n${data.stack ?? ''}`;
      }
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  debug(msg: string, data?: unknown): void {
    // oxlint-disable-next-line no-console
    if (this.shouldLog('debug')) {console.debug(this.format('debug', msg, data));}
  }

  info(msg: string, data?: unknown): void {
    // oxlint-disable-next-line no-console
    if (this.shouldLog('info')) {console.log(this.format('info', msg, data));}
  }

  // A hot fault path (claim rejections, unconfirmed hits, send failures)
  // can emit the same line every few ms under packet loss — one line per
  // event is a flood, not a signal. Identical messages inside 5s collapse
  // to every 8th with a count; distinct messages always land.
  private warnBurst = { msg: '', n: 0, at: 0 };
  private errorBurst = { msg: '', n: 0, at: 0 };

  private collapse(burst: { msg: string; n: number; at: number }, msg: string): string | null {
    const now = Date.now();
    if (msg === burst.msg && now - burst.at < 5000) {
burst.n += 1;
      if (burst.n % 8 !== 0) {return null;}
      return `${msg} (×${burst.n} suppressed repeats)`;
    }
    burst.msg = msg;
    burst.n = 0;
    burst.at = now;
    return msg;
  }

  warn(msg: string, data?: unknown): void {
    if (!this.shouldLog('warn')) {return;}
    const collapsed = this.collapse(this.warnBurst, msg);
    if (collapsed === null) {return;}
    const line = this.format('warn', collapsed, data);
    // oxlint-disable-next-line no-console
    console.warn(line);
    this.toFile(line);
  }

  error(msg: string, data?: unknown): void {
    if (!this.shouldLog('error')) {return;}
    const collapsed = this.collapse(this.errorBurst, msg);
    if (collapsed === null) {return;}
    const line = this.format('error', collapsed, data);
    // oxlint-disable-next-line no-console
    console.error(line);
    this.toFile(line);
  }
}

// P2P hosts embed the server modules (PlayerManager/CombatHandler) inside
// the browser — Bun.env doesn't exist there, so read it defensively.
// Base output is warn+error only: real faults (desync, rubberbanding,
// anomalies) stay loud while periodic chatter (Status rosters, mobility,
// bandwidth, hits, skills) lives at debug. LOG_LEVEL overrides outright;
// FPS_VERBOSE=1 is the convenient alias for 'debug'.
const bunEnv = (globalThis as { Bun?: { env: Record<string, string | undefined> } }).Bun?.env;
const envLevel = bunEnv?.LOG_LEVEL as LogLevel | undefined;
export const logger = new Logger(envLevel ?? (bunEnv?.FPS_VERBOSE === '1' ? 'debug' : 'warn'));
