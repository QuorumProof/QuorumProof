export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  module?: string;
  [key: string]: any;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class StructuredLogger {
  private currentLevel: LogLevel = 'info';
  private moduleLevels: Map<string, LogLevel> = new Map();

  constructor(private service: string = 'quorumproof-api') {
    const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
    if (envLevel && LOG_LEVELS.hasOwnProperty(envLevel)) {
      this.currentLevel = envLevel;
    }

    // Parse module-specific log levels from env (e.g., MODULE_LOGS=auth:debug,webhook:warn)
    const moduleLogs = process.env.MODULE_LOGS;
    if (moduleLogs) {
      moduleLogs.split(',').forEach(item => {
        const [module, level] = item.trim().split(':');
        if (module && level && LOG_LEVELS.hasOwnProperty(level)) {
          this.moduleLevels.set(module, level as LogLevel);
        }
      });
    }
  }

  private shouldLog(level: LogLevel, module?: string): boolean {
    const effectiveLevel = module && this.moduleLevels.has(module)
      ? this.moduleLevels.get(module)!
      : this.currentLevel;
    return LOG_LEVELS[level] >= LOG_LEVELS[effectiveLevel];
  }

  private formatEntry(
    level: LogLevel,
    message: string,
    module?: string,
    metadata?: Record<string, any>,
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      ...(module && { module }),
      message,
      ...metadata,
    };
  }

  debug(message: string, module?: string, metadata?: Record<string, any>): void {
    if (this.shouldLog('debug', module)) {
      console.log(JSON.stringify(this.formatEntry('debug', message, module, metadata)));
    }
  }

  info(message: string, module?: string, metadata?: Record<string, any>): void {
    if (this.shouldLog('info', module)) {
      console.log(JSON.stringify(this.formatEntry('info', message, module, metadata)));
    }
  }

  warn(message: string, module?: string, metadata?: Record<string, any>): void {
    if (this.shouldLog('warn', module)) {
      console.warn(JSON.stringify(this.formatEntry('warn', message, module, metadata)));
    }
  }

  error(message: string, module?: string, metadata?: Record<string, any>): void {
    if (this.shouldLog('error', module)) {
      console.error(JSON.stringify(this.formatEntry('error', message, module, metadata)));
    }
  }

  setLogLevel(level: LogLevel): void {
    if (LOG_LEVELS.hasOwnProperty(level)) {
      this.currentLevel = level;
    }
  }

  setModuleLogLevel(module: string, level: LogLevel): void {
    if (LOG_LEVELS.hasOwnProperty(level)) {
      this.moduleLevels.set(module, level);
    }
  }

  getLogLevel(): LogLevel {
    return this.currentLevel;
  }

  getModuleLogLevel(module: string): LogLevel | undefined {
    return this.moduleLevels.get(module);
  }
}

const logger = new StructuredLogger();

export { logger, StructuredLogger };
