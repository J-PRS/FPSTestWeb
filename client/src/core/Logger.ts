/**
 * Centralized logging system for client-side code
 * Matches server Logger.ts implementation for consistency
 */

import { settings } from './settings.js';
import { urlParams, isDevHost } from './params.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/** Local-time ISO stamp (`2026-10-02T19:15:48.852+02:00`) - toISOString
 *  is UTC-only, which made Alt+Q dumps read wrong vs wall clock. */
const padN = (n: number, w = 2): string => String(n).padStart(w, '0');
function tsLocal(d = new Date()): string {
  const p = padN;
  const off = -d.getTimezoneOffset(); // minutes EAST of UTC
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

// oxlint-disable-next-line no-namespace -- grouped statics are the public API shape
export namespace Logger {
  const fmtArg = (a: unknown): string =>
    ((): string => {
      if (a instanceof Error) {return a.stack ?? a.message;}
      if (typeof a === 'object') {try { return JSON.stringify(a); } catch { return String(a); }}
      return String(a);
    })();

  let currentLevel: LogLevel = LogLevel.INFO;
  // Console output is WARN+ only — INFO/DEBUG still land in the Alt+Q buffer
  const consoleLevel: LogLevel = LogLevel.WARN;
  let currentTag = '';
  const logBuffer: string[] = [];
  const maxBufferSize = 1000; // Keep last 1000 log entries
  // Trim a whole chunk once over cap+grace instead of shift() per push —
  // shift() is O(n) on every line under sustained log spam.
  const TRIM_GRACE = 128;
  function trimBuffer(): void {
    if (logBuffer.length > maxBufferSize + TRIM_GRACE) {
      logBuffer.splice(0, logBuffer.length - maxBufferSize);
    }
  }
  let writingToConsole = false; // suppress console wrapper re-entry
  // Consecutive-repeat fold — see log(); key is level+tag+body (no
  // timestamp), count resets on any different line.
  let lastFoldKey = '';
  let lastFoldCount = 0;

  /** Route stray console.warn/error through the buffer so Alt+Q sees
   *  EVERYTHING — a raw console call outside the logger is invisible to
   *  the dump otherwise. Native errors (throw, unhandledrejection) are
   *  already covered by installErrorHooks; the writingToConsole flag
   *  keeps our own console writes from recursing back in. */
  let tapInstalled = false;
  export function installConsoleTap(): void {
    if (tapInstalled || typeof window === 'undefined') {return;}
    tapInstalled = true;
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.warn = (...args: unknown[]): void => {
      if (writingToConsole) { origWarn(...args); return; }
      log(LogLevel.WARN, `[console.warn] ${args.map(fmtArg).join(' ')}`);
    };
    console.error = (...args: unknown[]): void => {
      if (writingToConsole) { origError(...args); return; }
      log(LogLevel.ERROR, `[console.error] ${args.map(fmtArg).join(' ')}`);
    };
  }

  /**
   * Set the minimum log level (default: INFO)
   * Can be configured via environment variable LOG_LEVEL
   */
  export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
  }

  /**
   * Set log level from string (for environment variable parsing)
   */
  export function setLogLevelFromString(levelStr: string): void {
    const level = levelStr.toUpperCase();
    switch (level) {
      case 'DEBUG': {
        currentLevel = LogLevel.DEBUG;
        break;
      }
      case 'INFO': {
        currentLevel = LogLevel.INFO;
        break;
      }
      case 'WARN': {
        currentLevel = LogLevel.WARN;
        break;
      }
      case 'ERROR': {
        currentLevel = LogLevel.ERROR;
        break;
      }
      default: {
        console.warn(`[Logger] Unknown log level: ${levelStr}, using INFO`);
        currentLevel = LogLevel.INFO;
      }
    }
  }

  /**
   * Check if a log level should be output
   */
  function shouldLog(level: LogLevel): boolean {
    return level >= currentLevel;
  }

  /** Console sink pick: DEBUG/INFO share log(), WARN/ERROR their own. */
  function writeConsole(level: LogLevel, fullMessage: string, context?: unknown): void {
    switch (level) {
      case LogLevel.DEBUG:
      case LogLevel.INFO: {
        console.log(fullMessage, context || '');
        break;
      }
      case LogLevel.WARN: {
        console.warn(fullMessage, context || '');
        break;
      }
      case LogLevel.ERROR: {
        console.error(fullMessage, context || '');
        break;
      }
      default: { break; }
    }
  }

  /**
   * Core logging method
   */
  function log(level: LogLevel, message: string, context?: unknown): void {
    if (!shouldLog(level)) {return;}

    const levelStr = LogLevel[level];
    const timestamp = tsLocal();
    const prefix = currentTag ? `[${currentTag}]` : '';
    const fullMessage = `${timestamp} ${prefix} [${levelStr}] ${message}`;

    if (level >= consoleLevel) {
      writingToConsole = true;
      try {
        writeConsole(level, fullMessage, context);
      } finally {
        writingToConsole = false;
      }
    }

    // Add to in-memory buffer for export
    const ctxStr = context === undefined ? '' : ` ${JSON.stringify(context)}`;
    const logLine = fullMessage + ctxStr;
    // Consecutive identical bodies fold into `line (×N)` — spam bursts
    // (desync warns, knockback stamps, "no live lane") used to evict
    // real history from the 1000-line cap while saying nothing new.
    // The fold key skips the timestamp so rapid repeats actually match.
    const foldKey = `${levelStr}|${prefix}|${message}${ctxStr}`;
    if (foldKey === lastFoldKey) {
lastFoldCount += 1;
      logBuffer[logBuffer.length - 1] = `${logLine} (×${lastFoldCount + 1})`;
    } else {
      lastFoldKey = foldKey;
      lastFoldCount = 0;
      logBuffer.push(logLine);
    }

    // WARN+ also queues for server shipping — the on-disk client.log
    if (level >= LogLevel.WARN) {queueForShip(logLine);}

    lineListener?.(logLine, level);
    if (level >= LogLevel.WARN) {complaintListener?.(logLine, level);}
    trimBuffer();
  }

  /** Live line feed for the in-game log panel — one subscriber, set once
   *  at boot. DOM work stays out of the logger: the panel decides whether
   *  it's worth appending (it no-ops while hidden). */
  type LineListener = (line: string, level: LogLevel) => void;
  let lineListener: LineListener | null = null;
  export function setLineListener(fn: LineListener | null): void {
    lineListener = fn;
  }

  /** WARN+ complaint feed for the HUD's conn-banner slot — every warn,
   *  error, and console-tap line surfaces live so a ghost-shell or
   *  dead-lane drop is visible mid-match without opening the console. */
  let complaintListener: LineListener | null = null;
  export function setComplaintListener(fn: LineListener | null): void {
    complaintListener = fn;
  }

  /** Register a diagnostics dump — prepended to Alt+Q/export output so bug
   *  reports carry live game state (isDead, connection, ids) not just logs. */
  let diagnosticsProvider: ((verbose: boolean) => string[]) | null = null;
  export function setDiagnostics(fn: (verbose: boolean) => string[]): void {
    diagnosticsProvider = fn;
  }

  function buildHeader(verbose = true): string[] {
    const lines = [`=== DIAGNOSTICS @ ${tsLocal()} ===`];
    try {
      if (diagnosticsProvider) {lines.push(...diagnosticsProvider(verbose));}
    } catch (error) {
      lines.push(`diagnostics threw: ${error}`);
    }
    lines.push('=== LOGS ===');
    return lines;
  }

  /**
   * Export logs as a downloadable file
   */
  export function exportLogs(): void {
    const logContent = [...buildHeader(), ...logBuffer].join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-${tsLocal().split('T')[0]}.log`;
    document.body.append(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Get all buffered logs
   */
  export function getLogs(): string[] {
    return [...logBuffer];
  }

  /**
   * Copy the last `count` buffered lines to the clipboard (Alt+Q).
   * Keydown counts as a user gesture so navigator.clipboard is allowed.
   */
  export async function copyLogs(count = 300, verbose = false): Promise<number> {
    const lines = [...buildHeader(verbose), ...logBuffer.slice(-count)].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      return logBuffer.slice(-count).length;
    } catch {
      // Clipboard unavailable (insecure context / denied) — fall back to console
      // (error so it bypasses the log/info console filter)
      console.error(lines);
      return -1;
    }
  }

  // ---- Log shipping ----
  // WARN/ERROR lines stream to POST <server>/client-log, which appends to
  // logs/client.log on disk. Batched every 5s; a sendBeacon on pagehide
  // catches the tail. No-op until initShipping is called with the URL.
  const shipQueue: string[] = [];
  // Offline/bot sessions never call initShipping — without a cap every
  // WARN+ line still queued for a flush that can never fire.
  const SHIP_QUEUE_MAX = 2000;
  function queueForShip(line: string): void {
    shipQueue.push(line);
    if (shipQueue.length > SHIP_QUEUE_MAX) {shipQueue.splice(0, shipQueue.length - SHIP_QUEUE_MAX);}
  }
  let shipUrl = '';

  export function initShipping(httpUrl: string): void {
    shipUrl = `${httpUrl.replace(/\/$/, '')}/client-log`;
    setInterval((): void => flushShipping(), 5000);
    document.addEventListener('visibilitychange', (): void => {
      if (document.visibilityState === 'hidden') {flushShipping(true);}
    });
  }

  // Uncaught errors install at module load, not at ship-time: a boot crash
  // before initShipping still reaches the queue and flushes once the
  // endpoint resolves (or stays in the local buffer if it never does).
  let errorHooksInstalled = false;
  export function installErrorHooks(): void {
    if (errorHooksInstalled) {return;}
    errorHooksInstalled = true;
    window.addEventListener('error', (e): void => {
      error(`UNCAUGHT ${e.message}`, { file: e.filename, line: e.lineno, stack: (e.error as Error)?.stack });
      flushBootCrash();
    });
    window.addEventListener('unhandledrejection', (e): void => {
      error('UNHANDLED REJECTION', { reason: String(e.reason), stack: (e.reason as Error)?.stack });
      flushBootCrash();
    });
  }

  // A crash before initShipping would otherwise die in the queue — the server
  // never sees the one log line that explains a black-screen boot. Resolve the
  // endpoint the same way connectServer does (?server= → tunnel wss/https,
  // else same-host:8000) and beacon the queue immediately.
  function flushBootCrash(): void {
    if (shipUrl || shipQueue.length === 0) {return;}
    const qp = new URLSearchParams(window.location.search);
    let host = qp.get('server')?.trim() ?? '';
    // oxlint-disable-next-line init-declarations -- assigned later
    let url!: string;
    if (host && (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host) || host.includes(':'))) {
      url = `http://${host.replace(/^https?:\/\//, '')}/client-log`;
    } else {
      if (host && !host.includes('.')) {host = `${host}.trycloudflare.com`;}
      url = host ? `https://${host}/client-log` : `http://${window.location.hostname || 'localhost'}:8000/client-log`;
    }
    const body = `${shipQueue.splice(0, shipQueue.length).join('\n')  }\n`;
    try {
      if (navigator.sendBeacon) {navigator.sendBeacon(url, body);}
      else {fetch(url, { method: 'POST', body, keepalive: true }).catch((): void => { return; });}
    } catch { /* shipping must never break the game */ }
  }

  function flushShipping(beacon = false): void {
    if (!shipUrl || shipQueue.length === 0) {return;}
    const body = `${shipQueue.splice(0, shipQueue.length).join('\n')  }\n`;
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(shipUrl, body);
      } else {
        fetch(shipUrl, { method: 'POST', body, keepalive: true }).catch((): void => { return; });
      }
    } catch { /* shipping must never break the game */ }
  }

  /** Push a line from outside the logger (console wrapper) */
  export function pushRaw(line: string, level: LogLevel = LogLevel.INFO): void {
    logBuffer.push(line);
    lineListener?.(line, level);
    trimBuffer();
    if (line.includes('[WARN]') || line.includes('[ERROR]')) {queueForShip(line);}
  }

  export function isWritingToConsole(): boolean {
    return writingToConsole;
  }

  export function debug(message: string, context?: unknown): void {
    log(LogLevel.DEBUG, message, context);
  }

  export function info(message: string, context?: unknown): void {
    log(LogLevel.INFO, message, context);
  }

  export function warn(message: string, context?: unknown): void {
    log(LogLevel.WARN, message, context);
  }

  export function error(message: string, context?: unknown): void {
    log(LogLevel.ERROR, message, context);
  }

  /** Log with a one-shot context tag (used by ChildLogger) */
  export function logTagged(level: LogLevel, tag: string, message: string, context?: unknown): void {
    const prevTag = currentTag;
    currentTag = tag;
    log(level, message, context);
    currentTag = prevTag;
  }
}

/**
 * ChildLogger for module-specific logging contexts
 */
export class ChildLogger {
  constructor(private context: string) {}

  debug(message: string, context?: unknown): void {
    Logger.logTagged(LogLevel.DEBUG, this.context, message, context);
  }

  info(message: string, context?: unknown): void {
    Logger.logTagged(LogLevel.INFO, this.context, message, context);
  }

  warn(message: string, context?: unknown): void {
    Logger.logTagged(LogLevel.WARN, this.context, message, context);
  }

  error(message: string, context?: unknown): void {
    Logger.logTagged(LogLevel.ERROR, this.context, message, context);
  }
}

declare global {
  interface Window {
    exportClientLogs?: () => void;
  }
}

// Initialize log level from environment variable if available (Vite)
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
if (viteEnv?.LOG_LEVEL) {
  Logger.setLogLevelFromString(viteEnv.LOG_LEVEL);
}

// Expose export function globally for manual export
const fmtArgs = (args: unknown[]): string =>
  args.map((a): string => (typeof a === 'string' ? a : ((): string => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');

if (typeof window !== 'undefined') {
  window.exportClientLogs = (): void => Logger.exportLogs();

  // Capture raw console.* calls that bypass the logger into the same buffer
  // (logger output is excluded via isWritingToConsole to avoid duplicates)
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    // log/info stay buffered for Alt+Q but don't hit the console — only
    // warn/error pass through (mirrors the Logger console filter)
    const passthrough = m === 'warn' || m === 'error';
    console[m] = (...args: unknown[]): void => {
      // Raw console lines keep their level for the panel's coloring —
      // log/info read as INFO, warn/error stay warn/error.
      let lvl = LogLevel.INFO;
if (m === 'warn') {lvl = LogLevel.WARN;}
else if (m === 'error') {lvl = LogLevel.ERROR;}
      if (!Logger.isWritingToConsole()) {Logger.pushRaw(`${tsLocal()} [${m.toUpperCase()}] ${fmtArgs(args)}`, lvl);}
      if (passthrough) {orig(...args);}
    };
  }

  // Alt+Q — copy last 300 log lines to clipboard without opening devtools
  let toastEl: HTMLDivElement | null = null;
  let toastTimer = 0;
  const toast = (msg: string, ok = true): void => {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'altq-toast';
      toastEl.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:8px 18px;border-radius:6px;background:rgba(10,16,22,0.9);border:1px solid rgba(255,255,255,0.2);color:#dfe;font:600 13px/1.2 "Segoe UI",Arial,sans-serif;letter-spacing:0.05em;z-index:99999;pointer-events:none;transition:opacity 0.2s;';
      document.body.append(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok ? 'rgba(120,255,180,0.5)' : 'rgba(255,120,120,0.5)';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout((): void => { toastEl!.style.opacity = '0'; }, 1500) as unknown as number;
  };
  document.addEventListener('keydown', (e): void => {
    // F1 — same visuals-only debug flag the menu DEBUG toggle writes
    // (settings.fps-debug); every consumer reads urlParams.debug live,
    // so no reload. Browsers own F1 for help — preventDefault keeps it.
    if (e.code === 'F1' && isDevHost()) {
      e.preventDefault();
      const on = !settings.get('fps-debug');
      settings.set('fps-debug', on ? 1 : 0);
      // Toast the EFFECTIVE state — on an https deploy the flag is
      // force-off, and "DEBUG ON" with no wireframes is a lie.
      toast(urlParams.debug ? 'DEBUG ON' : 'DEBUG OFF');
      return;
    }
    if (e.altKey && e.code === 'KeyQ') {
      e.preventDefault();
      // Shift+Alt+Q: game-state dump (scoreboard/ASW), not logs.
      if (e.shiftKey) {
        const dump = (window as { __gameDump?: () => string[] }).__gameDump?.() ?? [];
        const text = `=== GAME STATE ===\n${dump.join('\n')}`;
        navigator.clipboard.writeText(text).then((): void => { toast(`Game state copied (${dump.length} rows)`); },
          (): void => { console.log(text); toast('Clipboard unavailable — dumped to console', false); }).catch((): void => undefined);
        return;
      }
      const verbose = e.ctrlKey;
      Logger.copyLogs(300, verbose).then((n): void => {
        if (n >= 0) {
          toast(`Copied ${n} log lines${verbose ? ' (full census)' : ''}`);
          console.log(`[Logger] Copied ${n} log lines to clipboard`);
        } else {
          toast('Clipboard unavailable — dumped to console', false);
          console.log('[Logger] Clipboard unavailable — dumped to console');
        }
      return; }).catch((): void => undefined);
    }
  });

  console.log('Client logging initialized. Call exportClientLogs() to download logs, Alt+Q to copy.');
}

// Module-load install — importing Logger anywhere (main.ts imports it first)
// arms the hooks before boot-time crashes can happen.
Logger.installErrorHooks();
Logger.installConsoleTap();

export default Logger;
