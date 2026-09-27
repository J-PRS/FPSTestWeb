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

class Logger {
  private static currentLevel: LogLevel = LogLevel.INFO;
  // Console output is WARN+ only — INFO/DEBUG still land in the Alt+Q buffer
  private static consoleLevel: LogLevel = LogLevel.WARN;
  private static context: string = '';
  private static logBuffer: string[] = [];
  private static maxBufferSize = 1000; // Keep last 1000 log entries
  private static writingToConsole = false; // suppress console wrapper re-entry

  /**
   * Set the minimum log level (default: INFO)
   * Can be configured via environment variable LOG_LEVEL
   */
  static setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  /**
   * Set log level from string (for environment variable parsing)
   */
  static setLogLevelFromString(levelStr: string): void {
    const level = levelStr.toUpperCase();
    switch (level) {
      case 'DEBUG':
        this.currentLevel = LogLevel.DEBUG;
        break;
      case 'INFO':
        this.currentLevel = LogLevel.INFO;
        break;
      case 'WARN':
        this.currentLevel = LogLevel.WARN;
        break;
      case 'ERROR':
        this.currentLevel = LogLevel.ERROR;
        break;
      default:
        console.warn(`[Logger] Unknown log level: ${levelStr}, using INFO`);
        this.currentLevel = LogLevel.INFO;
    }
  }

  /**
   * Check if a log level should be output
   */
  private static shouldLog(level: LogLevel): boolean {
    return level >= this.currentLevel;
  }

  /**
   * Core logging method
   */
  private static log(level: LogLevel, message: string, context?: any): void {
    if (!this.shouldLog(level)) return;

    const levelStr = LogLevel[level];
    const timestamp = new Date().toISOString();
    const prefix = this.context ? `[${this.context}]` : '';
    const fullMessage = `${timestamp} ${prefix} [${levelStr}] ${message}`;

    if (level >= this.consoleLevel) {
      this.writingToConsole = true;
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
        this.writingToConsole = false;
      }
    }

    // Add to in-memory buffer for export
    const logLine = context !== undefined 
      ? `${fullMessage} ${JSON.stringify(context)}`
      : fullMessage;
    this.logBuffer.push(logLine);

    // WARN+ also queues for server shipping — the on-disk client.log
    if (level >= LogLevel.WARN) this.shipQueue.push(logLine);
    
    // Keep buffer size limited
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }

  /** Register a diagnostics dump — prepended to Alt+Q/export output so bug
   *  reports carry live game state (isDead, connection, ids) not just logs. */
  private static diagnosticsProvider: (() => string[]) | null = null;
  static setDiagnostics(fn: () => string[]): void {
    this.diagnosticsProvider = fn;
  }

  private static buildHeader(): string[] {
    const lines = [`=== DIAGNOSTICS @ ${new Date().toISOString()} ===`];
    try {
      if (this.diagnosticsProvider) lines.push(...this.diagnosticsProvider());
    } catch (e) {
      lines.push(`diagnostics threw: ${e}`);
    }
    lines.push('=== LOGS ===');
    return lines;
  }

  /**
   * Export logs as a downloadable file
   */
  static exportLogs(): void {
    const logContent = [...this.buildHeader(), ...this.logBuffer].join('\n');
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
  static getLogs(): string[] {
    return [...this.logBuffer];
  }

  /**
   * Copy the last `count` buffered lines to the clipboard (Alt+Q).
   * Keydown counts as a user gesture so navigator.clipboard is allowed.
   */
  static async copyLogs(count = 300): Promise<number> {
    const lines = [...this.buildHeader(), ...this.logBuffer.slice(-count)].join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      return this.logBuffer.slice(-count).length;
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
  private static shipQueue: string[] = [];
  private static shipUrl = '';

  static initShipping(httpUrl: string): void {
    this.shipUrl = `${httpUrl.replace(/\/$/, '')}/client-log`;
    setInterval(() => this.flushShipping(), 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushShipping(true);
    });
  }

  private static flushShipping(beacon = false): void {
    if (!this.shipUrl || this.shipQueue.length === 0) return;
    const body = this.shipQueue.splice(0, this.shipQueue.length).join('\n') + '\n';
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(this.shipUrl, body);
      } else {
        void fetch(this.shipUrl, { method: 'POST', body, keepalive: true }).catch(() => {});
      }
    } catch { /* shipping must never break the game */ }
  }

  /** Push a line from outside the logger (console wrapper) */
  static pushRaw(line: string): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > this.maxBufferSize) this.logBuffer.shift();
    if (line.includes('[WARN]') || line.includes('[ERROR]')) this.shipQueue.push(line);
  }

  static get isWritingToConsole(): boolean {
    return this.writingToConsole;
  }

  static debug(message: string, context?: any): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  static info(message: string, context?: any): void {
    this.log(LogLevel.INFO, message, context);
  }

  static warn(message: string, context?: any): void {
    this.log(LogLevel.WARN, message, context);
  }

  static error(message: string, context?: any): void {
    this.log(LogLevel.ERROR, message, context);
  }

  /** Log with a one-shot context tag (used by ChildLogger) */
  static logTagged(level: LogLevel, tag: string, message: string, context?: any): void {
    const prevContext = this.context;
    this.context = tag;
    this.log(level, message, context);
    this.context = prevContext;
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
if (typeof window !== 'undefined') {
  window.exportClientLogs = () => Logger.exportLogs();

  // Capture raw console.* calls that bypass the logger into the same buffer
  // (logger output is excluded via isWritingToConsole to avoid duplicates)
  const fmt = (args: unknown[]) =>
    args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[m].bind(console);
    // log/info stay buffered for Alt+Q but don't hit the console — only
    // warn/error pass through (mirrors the Logger console filter)
    const passthrough = m === 'warn' || m === 'error';
    console[m] = (...args: unknown[]) => {
      if (!Logger.isWritingToConsole) Logger.pushRaw(`${new Date().toISOString()} [${m.toUpperCase()}] ${fmt(args)}`);
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

export default Logger;
