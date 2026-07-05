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

  constructor(level: LogLevel = 'info') {
    this.level = level;
    this.startTime = performance.now();
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
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
    if (this.shouldLog('debug')) console.debug(this.format('debug', msg, data));
  }

  info(msg: string, data?: unknown): void {
    if (this.shouldLog('info')) console.log(this.format('info', msg, data));
  }

  warn(msg: string, data?: unknown): void {
    if (this.shouldLog('warn')) console.warn(this.format('warn', msg, data));
  }

  error(msg: string, data?: unknown): void {
    if (this.shouldLog('error')) console.error(this.format('error', msg, data));
  }
}

export const logger = new Logger(
  (Bun.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
);
