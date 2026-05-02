/**
 * Hardware detection helpers for opting users into hybrid/local routing.
 *
 * Used by `alpha-loop init` to decide whether to offer the hybrid/local
 * routing docs. Detection is intentionally conservative — we only prompt
 * when we're confident the machine can actually run a 30B-class local coder.
 */
import * as os from 'node:os';

const MIN_HYBRID_MEMORY_GB = 64;

/** True on Apple Silicon (M1/M2/M3/M4/…) Macs. */
export function detectAppleSilicon(): boolean {
  if (os.platform() !== 'darwin') return false;
  if (os.arch() !== 'arm64') return false;
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return false;
  return /^Apple\s+M\d/i.test(cpus[0]!.model ?? '');
}

/** Total system memory in gibibytes. */
export function getTotalMemoryGB(): number {
  return os.totalmem() / (1024 ** 3);
}

/**
 * True when the machine has enough hardware to run the recommended
 * hybrid-v1 profile (Apple Silicon + at least 64GB RAM).
 */
export function shouldOfferLocalMode(): boolean {
  return detectAppleSilicon() && getTotalMemoryGB() >= MIN_HYBRID_MEMORY_GB;
}
