/**
 * Factory Inbox — the human-editable rough-ideas file the factory PM reads.
 *
 * The file is plain markdown. Every top-level `- [ ] ...` checkbox bullet is an
 * idea; the checkbox character is its status and a trailing HTML comment
 * (`<!-- factory:id=I-xxxxxx k=v -->`) carries the factory's bookkeeping.
 * Everything else — headings, prose, blank lines, unrelated bullets — is the
 * human's and is preserved verbatim. Writes rewrite only the one bullet line
 * being changed, re-reading the file immediately before writing so edits the
 * human saved in the meantime survive.
 *
 * Continuation lines indented (2+ spaces or a tab) directly under a bullet
 * belong to that idea's text. An untagged idea's id is derived from its
 * normalized text, so it is stable until the factory first tags it. Ids are
 * unique within the file: a repeated text (or a copied tag) gets the same
 * `#n` disambiguation appendIdea uses, assigned in file order.
 *
 * Every read-modify-write holds `<inbox>.lock`, so the `factory idea` CLI and
 * the supervisor (separate processes) cannot lose each other's writes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { defaultPidAlive, withFileLockSync } from './lease.js';

export type IdeaStatus = 'pending' | 'taken' | 'done' | 'question' | 'rejected';

export type InboxIdea = {
  id: string;
  status: IdeaStatus;
  text: string;
  note: string;
  line: number; // 0-based line of the bullet
  meta: Record<string, string>;
};

const STATUS_CHAR: Record<IdeaStatus, string> = {
  pending: ' ',
  taken: '~',
  done: 'x',
  question: '?',
  rejected: '-',
};

const CHAR_STATUS: Record<string, IdeaStatus> = {
  ' ': 'pending',
  '~': 'taken',
  x: 'done',
  X: 'done',
  '?': 'question',
  '-': 'rejected',
};

const INBOX_HEADER = [
  '# Alpha Loop ideas inbox',
  'Drop rough ideas below as `- [ ] ...` bullets. The factory PM turns each into issues.',
  '',
  '',
].join('\n');

/** Separator between the idea text and the factory's note on a bullet line. */
const NOTE_SEP = ' → ';

// Top-level bullets only (0–1 leading spaces); deeper bullets are continuation text.
const BULLET_RE = /^( ?)([-*+])\s+\[([ ~xX?-])\]\s?(.*)$/;
const TAG_RE = /\s*<!--\s*factory:([^>]*?)\s*-->\s*$/;
const CONTINUATION_RE = /^(?: {2,}|\t)\s*\S/;
const FENCE_RE = /^ ?(```|~~~)/;
const META_KEY_RE = /^[A-Za-z0-9_.-]+$/;

type InboxEntry = {
  idea: InboxIdea;
  indent: string;
  marker: string;
  head: string; // the bullet line's own text (no note, no tag)
};

/** `I-` + first 6 hex chars of sha256 over the whitespace-normalized, lowercased text. */
export function ideaIdFor(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return `I-${createHash('sha256').update(normalized).digest('hex').slice(0, 6)}`;
}

function parseTag(body: string): { id?: string; meta: Record<string, string> } {
  const meta: Record<string, string> = {};
  let id: string | undefined;
  for (const token of body.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === 'id') id = value;
    else meta[key] = value;
  }
  return { id, meta };
}

function parseEntries(lines: string[]): InboxEntry[] {
  const entries: InboxEntry[] = [];
  // Every explicit tag in the file, so a computed id never collides with a tag
  // that appears later in the file.
  const explicitTags = new Set<string>();
  {
    let fence = false;
    for (const line of lines) {
      if (FENCE_RE.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const bullet = BULLET_RE.exec(line);
      const tag = bullet ? TAG_RE.exec(bullet[4]) : null;
      const id = tag ? parseTag(tag[1]).id : undefined;
      if (id) explicitTags.add(id);
    }
  }
  const used = new Set<string>();
  const uniqueId = (tagId: string | undefined, text: string): string => {
    // First holder of an explicit tag keeps it.
    if (tagId && !used.has(tagId)) return tagId;
    // Untagged ideas and copied tags: the text-derived id, disambiguated with
    // appendIdea's `${text}\n#n` scheme against every id already used and
    // every explicit tag anywhere in the file.
    let id = ideaIdFor(text);
    for (let n = 2; used.has(id) || explicitTags.has(id); n++) id = ideaIdFor(`${text}\n#${n}`);
    return id;
  };
  let inFence = false;
  let current: { entry: Omit<InboxEntry, 'idea'>; line: number; status: IdeaStatus; tagId?: string; note: string; meta: Record<string, string>; continuation: string[] } | null = null;

  const finish = () => {
    if (!current) return;
    const text = [current.entry.head, ...current.continuation].join('\n');
    const id = uniqueId(current.tagId, text);
    used.add(id);
    entries.push({
      ...current.entry,
      idea: {
        id,
        status: current.status,
        text,
        note: current.note,
        line: current.line,
        meta: current.meta,
      },
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      finish();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      finish();
      let rest = bullet[4];
      let tagId: string | undefined;
      let meta: Record<string, string> = {};
      const tag = TAG_RE.exec(rest);
      if (tag) {
        rest = rest.slice(0, tag.index);
        ({ id: tagId, meta } = parseTag(tag[1]));
      }
      rest = rest.trim();
      let head = rest;
      let note = '';
      // Only machine-written (tagged) lines carry a note; a human's own arrow stays in the text.
      if (tag) {
        const at = rest.lastIndexOf(NOTE_SEP);
        if (at >= 0) {
          head = rest.slice(0, at).trim();
          note = rest.slice(at + NOTE_SEP.length).trim();
        }
      }
      if (!head) continue; // an empty checkbox is not an idea
      current = {
        entry: { indent: bullet[1], marker: bullet[2], head },
        line: i,
        status: CHAR_STATUS[bullet[3]] ?? 'pending',
        tagId,
        note,
        meta,
        continuation: [],
      };
      continue;
    }

    if (current && (CONTINUATION_RE.test(line) || (current.meta.source === 'qa' && /^ {2}/.test(line)))) {
      current.continuation.push(current.meta.source === 'qa' ? line.slice(2) : line.trim());
      continue;
    }
    finish();
  }
  finish();
  return entries;
}

export function parseInbox(markdown: string): InboxIdea[] {
  return parseEntries(markdown.split(/\r?\n/)).map((entry) => entry.idea);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim();
}

function renderBullet(entry: Pick<InboxEntry, 'indent' | 'marker' | 'head'>, id: string, status: IdeaStatus, note: string, meta: Record<string, string>): string {
  // A literal note separator in the text would be misread as the note on the next parse.
  const head = oneLine(entry.head).split(NOTE_SEP.trim()).join('->');
  const tag = [`id=${id}`];
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'id' || !META_KEY_RE.test(key)) continue;
    tag.push(`${key}=${value.replace(/\s+/g, '_').replace(/-->|>/g, '')}`);
  }
  const noteText = oneLine(note);
  return `${entry.indent}${entry.marker} [${STATUS_CHAR[status]}] ${head}${noteText ? `${NOTE_SEP}${noteText}` : ''}  <!-- factory:${tag.join(' ')} -->`;
}

/** Create the inbox with its header if it does not exist (parent dirs included). */
export function ensureInboxFile(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, INBOX_HEADER, { flag: 'wx' });
}

export function readInbox(path: string): InboxIdea[] {
  if (!existsSync(path)) return [];
  return parseInbox(readFileSync(path, 'utf-8'));
}

/** Cross-process mutex around one read-modify-write of the inbox. */
function withInboxLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(`${path}.lock`, fn, { timeoutMs: 30_000, staleMs: 60_000 });
}

function readLines(path: string): { lines: string[]; eol: string } {
  const raw = readFileSync(path, 'utf-8');
  return { lines: raw.split(/\r?\n/), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * Append a pending idea. The first line becomes the bullet; further lines become
 * indented continuation lines. The bullet is tagged with an id that is unique
 * within the file (identical texts get distinct ids).
 */
export function appendIdea(path: string, text: string): InboxIdea {
  const parts = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Idea text is empty');
  ensureInboxFile(path);
  return withInboxLock(path, () => appendIdeaLocked(path, parts));
}

/** Check and append under the same lock; tagged failures stay deduplicated after PM processing. */
export function appendTaggedIdea(path: string, text: string, tag: { source: string; fingerprint: string }): { idea: InboxIdea; created: boolean } {
  const parts = text.replace(/\r\n?/g, '\n').trim().split('\n');
  if (!parts[0]?.trim() || !/^[A-Za-z0-9_-]+$/.test(tag.source) || !/^[a-f0-9]{64}$/.test(tag.fingerprint)) {
    throw new Error('Invalid tagged idea');
  }
  return withInboxLock(path, () => {
    ensureInboxFile(path);
    const existing = readInbox(path).find(idea => idea.meta.source === tag.source && idea.meta.fingerprint === tag.fingerprint);
    if (existing) return { idea: existing, created: false };
    return { idea: appendIdeaLocked(path, parts, tag), created: true };
  });
}

function appendIdeaLocked(path: string, parts: string[], meta: Record<string, string> = {}): InboxIdea {
  const { lines, eol } = readLines(path);
  const taken = new Set(parseEntries(lines).map((entry) => entry.idea.id));
  const fullText = parts.join('\n');
  let id = ideaIdFor(fullText);
  for (let n = 2; taken.has(id); n++) id = ideaIdFor(`${fullText}\n#${n}`);

  // Drop trailing blank lines, then append after exactly one separating newline.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const bullet = renderBullet({ indent: '', marker: '-', head: parts[0] }, id, 'pending', '', meta);
  const line = lines.length;
  lines.push(bullet, ...parts.slice(1).map((part) => `  ${meta.source === 'qa' ? part : oneLine(part)}`), '');
  writeFileAtomic(path, lines.join(eol));

  return parseInbox(lines.join('\n')).find((idea) => idea.line === line)
    ?? { id, status: 'pending', text: fullText, note: '', line, meta };
}

function patchedBullet(entry: InboxEntry, patch: { status: IdeaStatus; note?: string; meta?: Record<string, string> }, now: Date): string {
  const note = patch.note !== undefined ? patch.note : entry.idea.note;
  const meta = patch.meta !== undefined ? { ...patch.meta } : { ...entry.idea.meta };
  // The `taken` stamp and the PM worker's pid/host/worker only mean something while the idea is taken.
  if (patch.meta === undefined && patch.status !== 'taken') {
    delete meta.taken;
    delete meta.pid;
    delete meta.host;
    delete meta.worker;
  }
  if (patch.status === 'taken' && !meta.taken) meta.taken = isoSeconds(now);
  return renderBullet(entry, entry.idea.id, patch.status, note, meta);
}

/**
 * Rewrite one idea's bullet line (continuation lines are kept as-is).
 *
 * `note` undefined keeps the current note; '' clears it. `meta` replaces the
 * non-id tag fields when given; when omitted the existing fields are kept,
 * except `taken`, which is dropped unless the new status is 'taken'. Moving
 * to 'taken' without a `taken` meta value stamps the current time.
 *
 * `opts.line` (the caller's snapshot of the idea's line) is preferred when an
 * entry with that id sits there; otherwise the entry with that id is used
 * (ids are unique per file, so lines may shift under human edits).
 * Returns false when the file or the idea is missing.
 */
export function updateIdea(
  path: string,
  id: string,
  patch: { status: IdeaStatus; note?: string; meta?: Record<string, string> },
  opts: { line?: number } = {},
): boolean {
  if (!existsSync(path)) return false;
  return withInboxLock(path, () => {
    const { lines, eol } = readLines(path);
    const matches = parseEntries(lines).filter((candidate) => candidate.idea.id === id);
    const entry = matches.find((candidate) => candidate.idea.line === opts.line) ?? matches[0];
    if (!entry) return false;
    lines[entry.idea.line] = patchedBullet(entry, patch, new Date());
    writeFileAtomic(path, lines.join(eol));
    return true;
  });
}

export function nextPendingIdeas(ideas: InboxIdea[], limit: number): InboxIdea[] {
  if (limit <= 0) return [];
  return ideas.filter((idea) => idea.status === 'pending' && idea.text.trim() !== '').slice(0, limit);
}

/**
 * Return ideas stuck in 'taken' (e.g. a PM worker died) to 'pending'.
 *
 * When the idea records the PM worker's `pid` and `host` (this host), the pid
 * decides: a live worker keeps the idea taken, a dead one frees it at once.
 * Otherwise an idea is stale when its `taken` stamp is older than
 * `olderThanMinutes` or missing/unparseable. `skipIds` (the idea a live PM
 * worker of this supervisor holds) are never touched. All recoveries land in
 * a single atomic write. Returns the recovered ids.
 */
export function recoverTakenIdeas(
  path: string,
  opts: { olderThanMinutes: number; now?: Date; skipIds?: string[]; isPidAlive?: (pid: number) => boolean },
): string[] {
  if (!existsSync(path)) return [];
  const now = opts.now ?? new Date();
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;
  const skip = new Set(opts.skipIds ?? []);
  return withInboxLock(path, () => {
    const { lines, eol } = readLines(path);
    const recovered: string[] = [];
    for (const entry of parseEntries(lines)) {
      if (entry.idea.status !== 'taken' || skip.has(entry.idea.id)) continue;
      const pid = Number(entry.idea.meta.pid);
      const local = entry.idea.meta.host !== undefined && entry.idea.meta.host === hostname();
      let stale: boolean;
      if (local && Number.isInteger(pid) && pid > 0) {
        stale = !isPidAlive(pid);
      } else {
        const takenAt = Date.parse(entry.idea.meta.taken ?? '');
        stale = Number.isNaN(takenAt) || now.getTime() - takenAt > opts.olderThanMinutes * 60_000;
      }
      if (!stale) continue;
      const meta = { ...entry.idea.meta };
      delete meta.taken;
      delete meta.pid;
      delete meta.host;
      delete meta.worker;
      lines[entry.idea.line] = patchedBullet(entry, { status: 'pending', meta }, now);
      recovered.push(entry.idea.id);
    }
    if (recovered.length > 0) writeFileAtomic(path, lines.join(eol));
    return recovered;
  });
}
