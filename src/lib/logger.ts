/**
 * Structured logging helpers.
 * Stub for issue #73 — provides logging used by all engine modules.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string): void {
  const prefix = level === 'error' ? '✗' : level === 'warn' ? '⚠' : level === 'info' ? '→' : '·';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${prefix} ${message}\n`);
}

export function info(message: string): void {
  log('info', message);
}

export function warn(message: string): void {
  log('warn', message);
}

export function error(message: string): void {
  log('error', message);
}

export function debug(message: string): void {
  log('debug', message);
}

export function dry(message: string): void {
  process.stdout.write(`[DRY RUN] ${message}\n`);
}
