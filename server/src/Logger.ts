/**
 * Structured logging system with log levels
 * Replaces scattered console.log statements
 */

import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class Logger {
  private static logLevel: LogLevel = LogLevel.INFO;
  private static context: string = '';
  private static logFile: fs.WriteStream | null = null;
  private static logDir: string = path.join(process.cwd(), 'logs');

  /**
   * Initialize file logging
   */
  static initFileLogging(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      const logFileName = `server-${new Date().toISOString().split('T')[0]}.log`;
      const logFilePath = path.join(this.logDir, logFileName);
      this.logFile = fs.createWriteStream(logFilePath, { flags: 'a' });
      this.logFile.write(`\n=== Server started at ${new Date().toISOString()} ===\n`);
    } catch (error) {
      console.error(`Failed to initialize file logging: ${error}`);
    }
  }

  /**
   * Close file logging
   */
  static closeFileLogging(): void {
    if (this.logFile) {
      this.logFile.write(`\n=== Server stopped at ${new Date().toISOString()} ===\n`);
      this.logFile.end();
      this.logFile = null;
    }
  }

  /**
   * Set the minimum log level (logs below this level are suppressed)
   */
  static setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Set a context prefix for all log messages (e.g., "[Server]", "[PlayerManager]")
   */
  static setContext(context: string): void {
    this.context = context;
  }

  /**
   * Log debug message (lowest priority)
   */
  static debug(message: string, context?: any): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.log('DEBUG', message, context);
    }
  }

  /**
   * Log info message (default level)
   */
  static info(message: string, context?: any): void {
    if (this.logLevel <= LogLevel.INFO) {
      this.log('INFO', message, context);
    }
  }

  /**
   * Log warning message
   */
  static warn(message: string, context?: any): void {
    if (this.logLevel <= LogLevel.WARN) {
      this.log('WARN', message, context);
    }
  }

  /**
   * Log error message (highest priority)
   */
  static error(message: string, context?: any): void {
    if (this.logLevel <= LogLevel.ERROR) {
      this.log('ERROR', message, context);
    }
  }

  private static log(level: string, message: string, context?: any): void {
    const timestamp = new Date().toISOString();
    const prefix = this.context ? `[${this.context}]` : '';
    const fullMessage = `${timestamp} ${prefix} [${level}] ${message}`;

    if (context !== undefined) {
      console.log(fullMessage, context);
    } else {
      console.log(fullMessage);
    }

    // Write to file if initialized
    if (this.logFile) {
      const logLine = context !== undefined 
        ? `${fullMessage} ${JSON.stringify(context)}\n`
        : `${fullMessage}\n`;
      this.logFile.write(logLine);
    }
  }

  /**
   * Create a child logger with a specific context
   */
  static withContext(context: string): ChildLogger {
    return new ChildLogger(context);
  }
}

/**
 * Child logger with fixed context
 * Useful for creating module-specific loggers
 */
export class ChildLogger {
  constructor(private context: string) {}

  debug(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    Logger.setContext(this.context);
    Logger.debug(message, context);
    Logger.setContext(prevContext);
  }

  info(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    Logger.setContext(this.context);
    Logger.info(message, context);
    Logger.setContext(prevContext);
  }

  warn(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    Logger.setContext(this.context);
    Logger.warn(message, context);
    Logger.setContext(prevContext);
  }

  error(message: string, context?: any): void {
    const prevContext = (Logger as any).context;
    Logger.setContext(this.context);
    Logger.error(message, context);
    Logger.setContext(prevContext);
  }
}
