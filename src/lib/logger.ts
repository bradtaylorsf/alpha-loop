const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmt(label: string, color: string, msg: string): void {
  console.error(`${color}[${label}]${NC}  ${timestamp()} ${msg}`);
}

export const log = {
  info: (msg: string): void => fmt('INFO', BLUE, msg),
  success: (msg: string): void => fmt('OK', GREEN, msg),
  warn: (msg: string): void => fmt('WARN', YELLOW, msg),
  error: (msg: string): void => fmt('ERROR', RED, msg),
  step: (msg: string): void => fmt('STEP', CYAN, msg),
  dry: (msg: string): void => fmt('DRY', YELLOW, msg),
};
