/**
 * Factory Questions — the one place the factory asks the human anything.
 *
 * Questions live in a markdown file the human edits by hand: each question is a
 * `## Q-YYYYMMDD-NNN · status · role · label` section with a few `- key: value`
 * fields, the question, optional context, and an `**Answer:**` slot. The human
 * writes under **Answer:** and saves; parsing then reports the question as
 * `answered`, the supervisor acts on it and marks it `applied`. The human may
 * mark a question `dismissed` by editing its heading.
 *
 * Every write re-reads the file immediately before rendering, changes only the
 * target question, and writes atomically, so answers the human saved to other
 * questions are preserved. Writers (the supervisor and the `factory answer`
 * CLI, which are separate processes) hold `<questions>.lock` for the whole
 * read-modify-write so neither loses the other's update.
 * Free text outside question sections (other than the fixed header) is not
 * preserved across a write.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withFileLockSync } from './lease.js';

export type QuestionStatus = 'open' | 'answered' | 'applied' | 'dismissed';

export type FactoryQuestion = {
  id: string;
  status: QuestionStatus;
  role: string;
  askedAt: string;
  key: string;
  issue?: number;
  pr?: number;
  idea?: string;
  question: string;
  context: string;
  answer: string;
};

export type NewQuestion = Omit<FactoryQuestion, 'id' | 'status' | 'askedAt' | 'answer'> & { askedAt?: string };

const QUESTIONS_HEADER = [
  '# Alpha Loop — questions for you',
  'Answer under **Answer:** and save. The factory picks answers up on its next tick. Leave blank to skip.',
].join('\n');

const STATUSES: readonly QuestionStatus[] = ['open', 'answered', 'applied', 'dismissed'];

const HEADING_RE = /^##\s+(Q-\d{8}-\d+)(?=\s|$)(.*)$/;
const FIELD_RE = /^\s*[-*]\s+(asked|key|issue|pr|idea)\s*:\s*(.*)$/i;
const MARKER_RE = /^\*\*(Question|Context|Answer):\*\*\s?(.*)$/;
// Lines inside free text that would otherwise be read as structure; escaped with a leading backslash.
const STRUCTURAL_LINE_RE = /^(##\s+Q-\d|\*\*(?:Question|Context|Answer):\*\*)/;
const ESCAPED_LINE_RE = /^\\(##\s+Q-\d|\*\*(?:Question|Context|Answer):\*\*)/;

/** Placeholder answers that mean "not answered yet". */
const EMPTY_ANSWERS = new Set(['_(none)_', 'todo', '-']);

function normalizeAnswer(raw: string): string {
  const answer = raw.trim();
  return EMPTY_ANSWERS.has(answer.toLowerCase()) ? '' : answer;
}

function escapeText(text: string): string {
  return text.split('\n').map((line) => (STRUCTURAL_LINE_RE.test(line) ? `\\${line}` : line)).join('\n');
}

function unescapeText(text: string): string {
  return text.split('\n').map((line) => (ESCAPED_LINE_RE.test(line) ? line.slice(1) : line)).join('\n');
}

function parseNumber(value: string): number | undefined {
  const match = /#?(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function parseSection(id: string, headingRest: string, body: string[]): FactoryQuestion {
  // headingRest is ` · status · role · label`; the label is display-only.
  const parts = headingRest.split('·').map((part) => part.trim());
  const rawStatus = (parts[1] ?? '').toLowerCase();
  const fields: Record<string, string> = {};
  const text: Record<'question' | 'context' | 'answer', string[]> = { question: [], context: [], answer: [] };
  let section: 'fields' | 'question' | 'context' | 'answer' = 'fields';

  for (const line of body) {
    // The answer runs to the next question heading, whatever it contains.
    if (section === 'answer') {
      text.answer.push(line);
      continue;
    }
    const marker = MARKER_RE.exec(line);
    if (marker) {
      section = marker[1].toLowerCase() as 'question' | 'context' | 'answer';
      text[section].push(marker[2]);
      continue;
    }
    if (section === 'fields') {
      const field = FIELD_RE.exec(line);
      if (field) fields[field[1].toLowerCase()] = field[2].trim();
      continue;
    }
    text[section].push(line);
  }

  const answer = normalizeAnswer(unescapeText(text.answer.join('\n')));
  let status: QuestionStatus = STATUSES.includes(rawStatus as QuestionStatus) ? (rawStatus as QuestionStatus) : 'open';
  if (status === 'open' && answer) status = 'answered';
  else if (status === 'answered' && !answer) status = 'open';

  const question: FactoryQuestion = {
    id,
    status,
    role: parts[2] ?? '',
    askedAt: fields.asked ?? '',
    key: fields.key ?? '',
    question: unescapeText(text.question.join('\n')).trim(),
    context: unescapeText(text.context.join('\n')).trim(),
    answer,
  };
  const issue = fields.issue !== undefined ? parseNumber(fields.issue) : undefined;
  const pr = fields.pr !== undefined ? parseNumber(fields.pr) : undefined;
  if (issue !== undefined) question.issue = issue;
  if (pr !== undefined) question.pr = pr;
  if (fields.idea) question.idea = fields.idea;
  return question;
}

export function parseQuestions(markdown: string): FactoryQuestion[] {
  const questions: FactoryQuestion[] = [];
  let current: { id: string; rest: string; body: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current) questions.push(parseSection(current.id, current.rest, current.body));
      current = { id: heading[1], rest: heading[2], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) questions.push(parseSection(current.id, current.rest, current.body));
  return questions;
}

function headingField(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/·/g, '-').trim();
}

function renderQuestion(q: FactoryQuestion): string {
  const label = q.pr !== undefined ? `PR #${q.pr}` : q.issue !== undefined ? `issue #${q.issue}` : q.idea ? `idea ${headingField(q.idea)}` : '';
  const lines = [
    `## ${q.id} · ${q.status} · ${headingField(q.role)}${label ? ` · ${label}` : ''}`,
    `- asked: ${headingField(q.askedAt)}`,
    `- key: ${headingField(q.key)}`,
  ];
  if (q.issue !== undefined) lines.push(`- issue: #${q.issue}`);
  if (q.pr !== undefined) lines.push(`- pr: #${q.pr}`);
  if (q.idea) lines.push(`- idea: ${headingField(q.idea)}`);
  lines.push('', `**Question:** ${escapeText(q.question.trim())}`, '');
  if (q.context.trim()) lines.push(`**Context:** ${escapeText(q.context.trim())}`, '');
  lines.push('**Answer:**', escapeText(q.answer.trim()), '');
  return lines.join('\n');
}

function askedTime(q: FactoryQuestion): number {
  const time = Date.parse(q.askedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Header plus every question: open ones first, each group newest first. */
export function renderQuestions(questions: FactoryQuestion[]): string {
  const newestFirst = (a: FactoryQuestion, b: FactoryQuestion) =>
    askedTime(b) - askedTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const open = questions.filter((q) => q.status === 'open').sort(newestFirst);
  const rest = questions.filter((q) => q.status !== 'open').sort(newestFirst);
  return [QUESTIONS_HEADER, '', ...[...open, ...rest].map(renderQuestion)].join('\n');
}

export function readQuestions(path: string): FactoryQuestion[] {
  if (!existsSync(path)) return [];
  return parseQuestions(readFileSync(path, 'utf-8'));
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

function withQuestionsLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLockSync(`${path}.lock`, fn, { timeoutMs: 30_000, staleMs: 60_000 });
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Ask the human a question. Deduped by `key`: while a question with the same key
 * is open or answered, that question is returned with created=false. Once it is
 * applied or dismissed, the same key may be asked again. Ids are `Q-YYYYMMDD-NNN`
 * (UTC date of `now`, next free NNN for that day). An empty key never dedupes.
 */
export function askQuestion(path: string, q: NewQuestion, opts?: { now?: Date }): { question: FactoryQuestion; created: boolean } {
  return withQuestionsLock(path, () => askQuestionLocked(path, q, opts));
}

function askQuestionLocked(path: string, q: NewQuestion, opts?: { now?: Date }): { question: FactoryQuestion; created: boolean } {
  const now = opts?.now ?? new Date();
  const existing = readQuestions(path);
  const key = headingField(q.key);
  if (key) {
    const duplicate = existing.find((e) => e.key === key && (e.status === 'open' || e.status === 'answered'));
    if (duplicate) return { question: duplicate, created: false };
  }

  const prefix = `Q-${now.toISOString().slice(0, 10).replace(/-/g, '')}-`;
  let max = 0;
  for (const e of existing) {
    if (e.id.startsWith(prefix)) max = Math.max(max, Number(e.id.slice(prefix.length)) || 0);
  }

  const question: FactoryQuestion = {
    id: `${prefix}${String(max + 1).padStart(3, '0')}`,
    status: 'open',
    role: headingField(q.role),
    askedAt: q.askedAt ?? isoSeconds(now),
    key,
    question: q.question.trim(),
    context: (q.context ?? '').trim(),
    answer: '',
  };
  if (q.issue !== undefined) question.issue = q.issue;
  if (q.pr !== undefined) question.pr = q.pr;
  if (q.idea) question.idea = headingField(q.idea);

  writeFileAtomic(path, renderQuestions([...existing, question]));
  return { question, created: true };
}

function updateQuestion(path: string, id: string, change: (q: FactoryQuestion) => FactoryQuestion | null): boolean {
  if (!existsSync(path)) return false;
  return withQuestionsLock(path, () => {
    const questions = readQuestions(path);
    const index = questions.findIndex((q) => q.id === id);
    if (index < 0) return false;
    const next = change(questions[index]);
    if (!next) return false;
    questions[index] = next;
    writeFileAtomic(path, renderQuestions(questions));
    return true;
  });
}

/**
 * Record an answer (the CLI `factory answer` path). Only open or answered
 * questions accept an answer; a blank or placeholder answer is refused.
 */
export function answerQuestion(path: string, id: string, answer: string): boolean {
  const text = normalizeAnswer(answer);
  if (!text) return false;
  return updateQuestion(path, id, (q) =>
    q.status === 'open' || q.status === 'answered' ? { ...q, answer: text, status: 'answered' } : null);
}

export function markQuestion(path: string, id: string, status: QuestionStatus): boolean {
  return updateQuestion(path, id, (q) => ({ ...q, status }));
}

/** Questions with an answer the supervisor has not applied yet. */
export function answeredQuestions(questions: FactoryQuestion[]): FactoryQuestion[] {
  return questions.filter((q) => q.status === 'answered' || (q.status === 'open' && normalizeAnswer(q.answer) !== ''));
}

/** Questions still waiting on the human. */
export function openQuestionCount(questions: FactoryQuestion[]): number {
  return questions.filter((q) => q.status === 'open' && normalizeAnswer(q.answer) === '').length;
}
