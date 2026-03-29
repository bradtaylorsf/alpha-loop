/**
 * Logger Utility
 * ==============
 *
 * Centralized logging functions for the autonomous coding agent.
 * Provides structured logging with severity levels.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'http';

export interface LogContext {
  component?: string;
  session?: number;
  tool?: string;
  [key: string]: unknown;
}

/**
 * Core logging function that formats and outputs log messages.
 * 
 * @param level - The severity level of the log
 * @param message - The log message
 * @param context - Additional context information
 * 
 * @example
 * log('info', 'Agent started', { component: 'agent', session: 1 });
 */
export const log = (level: LogLevel, message: string, context?: LogContext): void => {
  const timestamp = new Date().toISOString();
  const prefix = context?.component ? `[${context.component}]` : '';
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  
  const formattedMessage = `${timestamp} ${level.toUpperCase()} ${prefix} ${message}${contextStr}`;
  
  switch (level) {
    case 'error':
      // eslint-disable-next-line no-console
      console.error(formattedMessage);
      break;
    case 'warn':
      // eslint-disable-next-line no-console
      console.warn(formattedMessage);
      break;
    case 'debug':
      if (process.env.DEBUG) {
        // eslint-disable-next-line no-console
        console.log(formattedMessage);
      }
      break;
    case 'http':
      // HTTP logs are info level but with http prefix
      // eslint-disable-next-line no-console
      console.log(formattedMessage);
      break;
    case 'info':
    default:
      // eslint-disable-next-line no-console
      console.log(formattedMessage);
  }
};

/**
 * Log an informational message.
 * 
 * @param message - The log message
 * @param context - Additional context information
 * 
 * @example
 * info('Server started', { port: 4245 });
 */
export const info = (message: string, context?: LogContext): void => {
  log('info', message, context);
};

/**
 * Log a warning message.
 * 
 * @param message - The warning message
 * @param context - Additional context information
 * 
 * @example
 * warn('Connection timeout', { retryCount: 3 });
 */
export const warn = (message: string, context?: LogContext): void => {
  log('warn', message, context);
};

/**
 * Log an error message.
 * 
 * @param message - The error message
 * @param context - Additional context information
 * 
 * @example
 * error('Failed to start agent', { error: err.message });
 */
export const error = (message: string, context?: LogContext): void => {
  log('error', message, context);
};

/**
 * Log a debug message (only shown when DEBUG env var is set).
 *
 * @param message - The debug message
 * @param context - Additional context information
 *
 * @example
 * debug('Tool status updated', { tool: 'playwright', status: 'healthy' });
 */
export const debug = (message: string, context?: LogContext): void => {
  log('debug', message, context);
};

/**
 * Log an HTTP request/response message.
 *
 * @param message - The HTTP log message
 * @param context - Additional context information
 *
 * @example
 * http('GET /api/projects 200 - 45ms');
 */
export const http = (message: string, context?: LogContext): void => {
  log('http', message, context);
};

/**
 * Create a logger with a specific component context.
 * 
 * @param component - The component name to include in all logs
 * @returns A logger object with bound context
 * 
 * @example
 * const logger = createLogger('Agent');
 * logger.info('Session started', { session: 1 });
 */
export const createLogger = (component: string) => ({
  info: (message: string, context?: Omit<LogContext, 'component'>) =>
    info(message, { ...context, component }),
  warn: (message: string, context?: Omit<LogContext, 'component'>) =>
    warn(message, { ...context, component }),
  error: (message: string, context?: Omit<LogContext, 'component'>) =>
    error(message, { ...context, component }),
  debug: (message: string, context?: Omit<LogContext, 'component'>) =>
    debug(message, { ...context, component }),
  http: (message: string, context?: Omit<LogContext, 'component'>) =>
    http(message, { ...context, component }),
});

/**
 * Default logger instance for general use.
 */
export const logger = {
  info,
  warn,
  error,
  debug,
  http,
};
