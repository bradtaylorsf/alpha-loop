/** Minimal logger — stub from #73, will be expanded later. */

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

export function logInfo(msg: string): void {
  console.log(`${CYAN}ℹ${NC} ${msg}`);
}

export function logSuccess(msg: string): void {
  console.log(`${GREEN}✓${NC} ${msg}`);
}

export function logWarn(msg: string): void {
  console.log(`${YELLOW}⚠${NC} ${msg}`);
}

export function logError(msg: string): void {
  console.error(`${RED}✗${NC} ${msg}`);
}

export function logStep(msg: string): void {
  console.log(`${BOLD}${CYAN}→${NC} ${msg}`);
}
