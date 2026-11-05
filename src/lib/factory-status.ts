/** Pure status formatting and bounded, read-only worker log tails. */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import type { FactoryPaths } from './config.js';
import type { FactoryState } from './factory.js';
import type { FactoryQuestion } from './factory-questions.js';
import type { LeasePayload } from './lease.js';

export type FactoryStatusSnapshot = {
  running: boolean;
  supervisor: Pick<LeasePayload, 'pid' | 'hostname' | 'acquiredAt' | 'refreshedAt'> | null;
  state: FactoryState | null;
  openQuestions: Array<Pick<FactoryQuestion, 'id' | 'status' | 'role' | 'askedAt' | 'key' | 'question'>>;
  pendingIdeas: number;
  paths: FactoryPaths;
};

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function cell(text: string, max = Infinity): string {
  const clean = stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** No filesystem, clock, console, or terminal operations: inputs fully determine the frame. */
export function renderFactoryStatus(
  snapshot: FactoryStatusSnapshot,
  { tails, now }: { tails: Readonly<Record<string, string>>; now: Date },
): string {
  const { state, supervisor, running } = snapshot;
  const lines: string[] = [];
  const age = (at: string): string => formatAge(now.getTime() - Date.parse(at));
  if (running && supervisor) {
    lines.push(`Factory: running (pid ${supervisor.pid}${state ? `, tick ${state.tick}, ${state.status}` : ''})`);
  } else {
    lines.push(`Factory: not running${state ? ` (last state ${state.status} at ${state.updatedAt})` : ''}`);
  }
  if (state) {
    lines.push(`Base: ${cell(state.baseBranch)} · developers: ${state.developers} · epics: ${state.epics.length ? state.epics.map((e) => `#${e}`).join(', ') : 'all'}`);
  }
  const workers = state?.workers ?? [];
  lines.push(`Workers (${workers.length}${!running && workers.length ? ', last recorded' : ''}):`);
  if (workers.length) {
    const rows = [
      ['ID', 'Role', 'Issue / idea', 'PID', 'Elapsed', 'Last log line'],
      ...workers.map((w) => [
        cell(w.id), cell(w.role), cell(w.issue !== undefined ? `#${w.issue}` : w.ideaId ?? '-'),
        String(w.pid ?? '-'), age(w.startedAt), cell(tails[w.id] ?? '-', 100) || '-',
      ]),
    ];
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
    for (const row of rows) {
      lines.push(`  ${row.map((value, i) => i === row.length - 1 ? value : value.padEnd(widths[i])).join('  ')}`);
    }
    for (const w of workers) lines.push(`  Log ${cell(w.id)}: ${cell(w.logPath)}`);
  } else {
    lines.push('  (none)');
  }
  if (state) {
    const dispatched = state.lastPlan.dispatched.map((n) => `#${n}`).join(', ') || 'nothing';
    lines.push(`Last plan: dispatched ${dispatched}; skipped ${state.lastPlan.skipped.length}`);
    for (const s of state.lastPlan.skipped.slice(0, 10)) {
      lines.push(`  #${s.issue} ${cell(s.reason)}${s.detail ? ` (${cell(s.detail)})` : ''}`);
    }
    const c = state.counts;
    lines.push(`Counts: dispatched ${c.dispatched} · succeeded ${c.succeeded} · failed ${c.failed} · waiting ${c.waiting} · merged ${c.merged} · ideas ${c.ideasIngested} · questions ${c.questionsAsked}`);
    if (state.ship.lastRunAt) {
      lines.push(`Ship: last pass ${cell(state.ship.lastRunAt)}${state.ship.error ? ` — error: ${cell(state.ship.error)}` : ''}`);
      for (const d of state.ship.decisions) lines.push(`  PR #${d.pr}: ${cell(d.action)} — ${cell(d.reason)}`);
    }
  }
  lines.push(`Open questions (${snapshot.openQuestions.length}):`);
  for (const q of snapshot.openQuestions) {
    lines.push(`  ${cell(q.id)}  ${age(q.askedAt)}  ${cell(q.role)}  ${cell(q.question.split('\n')[0], 100)}${q.status === 'answered' ? '  [answered]' : ''}`);
  }
  lines.push(`Pending ideas: ${snapshot.pendingIdeas}`);
  const recent = state?.recent?.slice(-5) ?? [];
  lines.push(`Recent events (${recent.length}):`);
  for (const { at, type, ...details } of recent) {
    const summary = cell(Object.entries(details)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' '), 160);
    lines.push(`  ${cell(at)}  ${cell(type)}${summary ? `  ${summary}` : ''}`);
  }
  lines.push(`Inbox: ${cell(snapshot.paths.inboxPath)}`);
  lines.push(`Questions: ${cell(snapshot.paths.questionsPath)}`);
  lines.push(`State: ${cell(snapshot.paths.statePath)}`);
  return lines.join('\n');
}

/** Reopen on every call; never read or allocate more than the last 4 KiB. */
export function readWorkerLogTail(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return '-';
    const length = Math.min(stat.size, 4096);
    const position = stat.size - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    // A byte window can start inside a UTF-8 character. Drop continuation bytes.
    let start = 0;
    while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
    const lines = buffer.subarray(start, bytesRead).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = cell(lines[i]);
      if (line) return `${position > 0 && i === 0 ? '…' : ''}${line}`;
    }
    return '-';
  } catch {
    return '-';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* A disappearing log must not break a frame. */ }
    }
  }
}

export function readWorkerLogTails(workers: ReadonlyArray<{ id: string; logPath: string }>): Record<string, string> {
  return Object.fromEntries(workers.map((w) => [w.id, readWorkerLogTail(w.logPath)]));
}
