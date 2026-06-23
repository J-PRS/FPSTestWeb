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
  private static context: string = '';
  private static logBuffer: string[] = [];
  private static maxBufferSize = 1000; // Keep last 1000 log entries

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

    switch (level) {
      case LogLevel.DEBUG:
        console.log(fullMessage, context || '');
        break;
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

    // Add to in-memory buffer for export
    const logLine = context !== undefined 
      ? `${fullMessage} ${JSON.stringify(context)}`
      : fullMessage;
    this.logBuffer.push(logLine);
    
    // Keep buffer size limited
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }

  /**
   * Export logs as a downloadable file
   */
  static exportLogs(): void {
    const logContent = this.logBuffer.join('\n');
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
}

/**
 * ChildLogger for module-specific logging contexts
 */
export class ChildLogger {
  constructor(private context: string) {}

  debug(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    (Logger as any).context = this.context;
    Logger.debug(message, context);
    (Logger as any).context = prevContext;
  }

  info(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    (Logger as any).context = this.context;
    Logger.info(message, context);
    (Logger as any).context = prevContext;
  }

  warn(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    (Logger as any).context = this.context;
    Logger.warn(message, context);
    (Logger as any).context = prevContext;
  }

  error(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    (Logger as any).context = this.context;
    Logger.error(message, context);
    (Logger as any).context = prevContext;
  }
}

// Initialize log level from environment variable if available (Vite)
if (typeof import.meta !== 'undefined' && (import.meta as any).env?.LOG_LEVEL) {
  Logger.setLogLevelFromString((import.meta as any).env.LOG_LEVEL);
}

// Expose export function globally for manual export
if (typeof window !== 'undefined') {
  (window as any).exportClientLogs = () => Logger.exportLogs();
  console.log('Client logging initialized. Call exportClientLogs() to download logs.');
}

export default Logger;
