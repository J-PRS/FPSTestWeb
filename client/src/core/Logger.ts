/**
 * Centralized logging system for client-side code
 * Matches server Logger.ts implementation for consistency
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export namespace Logger {
  let currentLevel: LogLevel = LogLevel.INFO;
  // Console output is WARN+ only — INFO/DEBUG still land in the Alt+Q buffer
  let consoleLevel: LogLevel = LogLevel.WARN;
  let currentTag: string = '';
  let logBuffer: string[] = [];
  let maxBufferSize = 1000; // Keep last 1000 log entries
  let writingToConsole = false; // suppress console wrapper re-entry

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
      case 'DEBUG':
        currentLevel = LogLevel.DEBUG;
        break;
      case 'INFO':
        currentLevel = LogLevel.INFO;
        break;
      case 'WARN':
        currentLevel = LogLevel.WARN;
        break;
      case 'ERROR':
        currentLevel = LogLevel.ERROR;
        break;
      default:
        console.warn(`[Logger] Unknown log level: ${levelStr}, using INFO`);
        currentLevel = LogLevel.INFO;
    }
  }

  /**
   * Check if a log level should be output
   */
  function shouldLog(level: LogLevel): boolean {
    return level >= currentLevel;
  }

  /**
   * Core logging method
   */
  function log(level: LogLevel, message: string, context?: any): void {
    if (!shouldLog(level)) return;

    const levelStr = LogLevel[level];
    const timestamp = new Date().toISOString();
    const prefix = currentTag ? `[${currentTag}]` : '';
    const fullMessage = `${timestamp} ${prefix} [${levelStr}] ${message}`;

    if (level >= consoleLevel) {
      writingToConsole = true;
      try {
        switch (level) {
          case LogLevel.DEBUG:
          case LogLevel.INFO:
            console.log(fullMessage, context || '');
            break;
          case LogLevel.WARN:
            console.warn(fullMessage, context || '');
            break;
          case LogLevel.ERROR:
            console.error(fullMessage, context || '');
            break;
        }
      } finally {
        writingToConsole = false;
      }
    }

    // Add to in-memory buffer for export
    const logLine = context !== undefined 
      ? `${fullMessage} ${JSON.stringify(context)}`
      : fullMessage;
    logBuffer.push(logLine);

    // WARN+ also queues for server shipping — the on-disk client.log
    if (level >= LogLevel.WARN) shipQueue.push(logLine);
    
    // Keep buffer size limited
    if (logBuffer.length > maxBufferSize) {
      logBuffer.shift();
    }
  }

  /** Register a diagnostics dump — prepended to Alt+Q/export output so bug
   *  reports carry live game state (isDead, connection, ids) not just logs. */
  let diagnosticsProvider: (() => string[]) | null = null;
  export function setDiagnostics(fn: () => string[]): void {
    diagnosticsProvider = fn;
  }

  function buildHeader(): string[] {
    const lines = [`=== DIAGNOSTICS @ ${new Date().toISOString()} ===`];
    try {
      if (diagnosticsProvider) lines.push(...diagnosticsProvider());
    } catch (e) {
      lines.push(`diagnostics threw: ${e}`);
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
    a.download = `client-${new Date().toISOString().split('T')[0]}.log`;
    document.body.appendChild(a);
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
  export async function copyLogs(count = 300): Promise<number> {
    const lines = [...buildHeader(), ...logBuffer.slice(-count)].join('\n');
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
  let shipQueue: string[] = [];
  let shipUrl = '';

  export function initShipping(httpUrl: string): void {
    shipUrl = `${httpUrl.replace(/\/$/, '')}/client-log`;
    setInterval(() => flushShipping(), 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushShipping(true);
    });
  }

  // Uncaught errors install at module load, not at ship-time: a boot crash
  // before initShipping still reaches the queue and flushes once the
  // endpoint resolves (or stays in the local buffer if it never does).
  let errorHooksInstalled = false;
  export function installErrorHooks(): void {
    if (errorHooksInstalled) return;
    errorHooksInstalled = true;
    window.addEventListener('error', (e) => {
      error(`UNCAUGHT ${e.message}`, { file: e.filename, line: e.lineno, stack: (e.error as Error)?.stack });
      flushBootCrash();
    });
    window.addEventListener('unhandledrejection', (e) => {
      error('UNHANDLED REJECTION', { reason: String(e.reason), stack: (e.reason as Error)?.stack });
      flushBootCrash();
    });
  }

  // A crash before initShipping would otherwise die in the queue — the server
  // never sees the one log line that explains a black-screen boot. Resolve the
  // endpoint the same way connectServer does (?server= → tunnel wss/https,
  // else same-host:8000) and beacon the queue immediately.
  function flushBootCrash(): void {
    if (shipUrl || shipQueue.length === 0) return;
    const qp = new URLSearchParams(window.location.search);
    let host = qp.get('server')?.trim() ?? '';
    let url: string;
    if (host && (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host) || host.includes(':'))) {
      url = `http://${host.replace(/^https?:\/\//, '')}/client-log`;
    } else {
      if (host && !host.includes('.')) host = `${host}.trycloudflare.com`;
      url = host ? `https://${host}/client-log` : `http://${window.location.hostname || 'localhost'}:8000/client-log`;
    }
    const body = shipQueue.splice(0, shipQueue.length).join('\n') + '\n';
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(url, body);
      else void fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
    } catch { /* shipping must never break the game */ }
  }

  function flushShipping(beacon = false): void {
    if (!shipUrl || shipQueue.length === 0) return;
    const body = shipQueue.splice(0, shipQueue.length).join('\n') + '\n';
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(shipUrl, body);
      } else {
        void fetch(shipUrl, { method: 'POST', body, keepalive: true }).catch(() => {});
      }
    } catch { /* shipping must never break the game */ }
  }

  /** Push a line from outside the logger (console wrapper) */
  export function pushRaw(line: string): void {
    logBuffer.push(line);
    if (logBuffer.length > maxBufferSize) logBuffer.shift();
    if (line.includes('[WARN]') || line.includes('[ERROR]')) shipQueue.push(line);
  }

  export function isWritingToConsole(): boolean {
    return writingToConsole;
  }

  export function debug(message: string, context?: any): void {
    log(LogLevel.DEBUG, message, context);
  }

  export function info(message: string, context?: any): void {
    log(LogLevel.INFO, message, context);
  }

  export function warn(message: string, context?: any): void {
    log(LogLevel.WARN, message, context);
  }

  export function error(message: string, context?: any): void {
    log(LogLevel.ERROR, message, context);
  }

  /** Log with a one-shot context tag (used by ChildLogger) */
  export function logTagged(level: LogLevel, tag: string, message: string, context?: any): void {
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

  debug(message: string, context?: any): void {
    Logger.logTagged(LogLevel.DEBUG, this.context, message, context);
  }

  info(message: string, context?: any): void {
    Logger.logTagged(LogLevel.INFO, this.context, message, context);
  }

  warn(message: string, context?: any): void {
    Logger.logTagged(LogLevel.WARN, this.context, message, context);
  }

  error(message: string, context?: any): void {
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
const fmtArgs = (args: unknown[]) =>
  args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');

if (typeof window !== 'undefined') {
  window.exportClientLogs = () => Logger.exportLogs();

  // Capture raw console.* calls that bypass the logger into the same buffer
  // (logger output is excluded via isWritingToConsole to avoid duplicates)
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    // log/info stay buffered for Alt+Q but don't hit the console — only
    // warn/error pass through (mirrors the Logger console filter)
    const passthrough = m === 'warn' || m === 'error';
    console[m] = (...args: unknown[]) => {
      if (!Logger.isWritingToConsole()) Logger.pushRaw(`${new Date().toISOString()} [${m.toUpperCase()}] ${fmtArgs(args)}`);
      if (passthrough) orig(...args);
    };
  }

  // Alt+Q — copy last 300 log lines to clipboard without opening devtools
  let toastEl: HTMLDivElement | null = null;
  let toastTimer = 0;
  const toast = (msg: string, ok = true) => {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:8px 18px;border-radius:6px;background:rgba(10,16,22,0.9);border:1px solid rgba(255,255,255,0.2);color:#dfe;font:600 13px/1.2 "Segoe UI",Arial,sans-serif;letter-spacing:0.05em;z-index:99999;pointer-events:none;transition:opacity 0.2s;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.borderColor = ok ? 'rgba(120,255,180,0.5)' : 'rgba(255,120,120,0.5)';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl!.style.opacity = '0'; }, 1500) as unknown as number;
  };
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyQ') {
      e.preventDefault();
      Logger.copyLogs(300).then(n => {
        if (n >= 0) {
          toast(`Copied ${n} log lines`);
          console.log(`[Logger] Copied ${n} log lines to clipboard`);
        } else {
          toast('Clipboard unavailable — dumped to console', false);
          console.log('[Logger] Clipboard unavailable — dumped to console');
        }
      });
    }
  });

  console.log('Client logging initialized. Call exportClientLogs() to download logs, Alt+Q to copy.');
}

// Module-load install — importing Logger anywhere (main.ts imports it first)
// arms the hooks before boot-time crashes can happen.
Logger.installErrorHooks();

export default Logger;
