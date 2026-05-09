/**
 * Normalize argv for package-manager script invocations.
 *
 * `pnpm dev -- triage --dry-run` can pass the separator through as a literal
 * argv item before the command. The published bin path does not need this, but
 * the dev script should behave the same way users expect npm-style forwarding
 * to behave.
 */
export function normalizeScriptArgv(argv: string[]): string[] {
  if (argv[2] !== '--') return argv;
  return [argv[0], argv[1], ...argv.slice(3)];
}
