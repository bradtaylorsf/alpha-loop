import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answeredQuestions,
  answerQuestion,
  askQuestion,
  markQuestion,
  openQuestionCount,
  parseQuestions,
  readQuestions,
  renderQuestions,
  type FactoryQuestion,
  type NewQuestion,
} from '../../src/lib/factory-questions.js';

const SAMPLE = [
  '# Alpha Loop — questions for you',
  'Answer under **Answer:** and save. The factory picks answers up on its next tick. Leave blank to skip.',
  '',
  '## Q-20261104-001 · open · shipper · PR #512',
  '- asked: 2026-11-04T23:12:00Z',
  '- key: ship:512:review-required',
  '- issue: #498',
  '- pr: #512',
  '- idea: I-77aa01',
  '',
  '**Question:** PR #512 is green but master requires an approving review the loop cannot give. Approve it, or allow admin merge?',
  '',
  '**Context:** Branch protection requires 1 review.',
  'Second context line.',
  '',
  '**Answer:**',
  '',
].join('\n');

const NEW_Q: NewQuestion = {
  role: 'shipper',
  key: 'ship:512:conflict',
  pr: 512,
  question: 'PR #512 conflicts with master. Resolve it?',
  context: '',
};

describe('factory-questions', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-questions-'));
    file = join(dir, 'nested', 'questions.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseQuestions', () => {
    it('parses heading, fields, question and multi-line context', () => {
      expect(parseQuestions(SAMPLE)).toEqual([{
        id: 'Q-20261104-001',
        status: 'open',
        role: 'shipper',
        askedAt: '2026-11-04T23:12:00Z',
        key: 'ship:512:review-required',
        issue: 498,
        pr: 512,
        idea: 'I-77aa01',
        question: 'PR #512 is green but master requires an approving review the loop cannot give. Approve it, or allow admin merge?',
        context: 'Branch protection requires 1 review.\nSecond context line.',
        answer: '',
      }]);
    });

    it('computes answered when an open question has a real answer, up to the next heading', () => {
      const markdown = SAMPLE + 'Allow admin merge.\n\nThanks!\n\n## Q-20261104-002 · open · pm · idea I-1\n- asked: 2026-11-04T23:20:00Z\n- key: pm:I-1\n\n**Question:** Which?\n\n**Answer:**\n';
      const [first, second] = parseQuestions(markdown);
      expect(first).toMatchObject({ status: 'answered', answer: 'Allow admin merge.\n\nThanks!' });
      expect(second).toMatchObject({ id: 'Q-20261104-002', status: 'open', role: 'pm', answer: '' });
      expect(second.issue).toBeUndefined();
      expect(second.pr).toBeUndefined();
    });

    it.each(['_(none)_', 'TODO', 'todo', '-', '   '])('treats the placeholder %p as no answer', (placeholder) => {
      const [q] = parseQuestions(`${SAMPLE}${placeholder}\n`);
      expect(q).toMatchObject({ status: 'open', answer: '' });
    });

    it('accepts an answer on the same line as the marker', () => {
      const [q] = parseQuestions(SAMPLE.replace('\n**Answer:**\n', '\n**Answer:** yes\n'));
      expect(q).toMatchObject({ status: 'answered', answer: 'yes' });
    });

    it('keeps applied/dismissed statuses, reverts an emptied answered question, and defaults unknown statuses', () => {
      const applied = parseQuestions(SAMPLE.replace('· open ·', '· applied ·') + 'done\n')[0];
      const dismissed = parseQuestions(SAMPLE.replace('· open ·', '· dismissed ·'))[0];
      const emptied = parseQuestions(SAMPLE.replace('· open ·', '· answered ·'))[0];
      const weird = parseQuestions(SAMPLE.replace('· open ·', '· whatever ·'))[0];
      expect([applied.status, dismissed.status, emptied.status, weird.status]).toEqual(['applied', 'dismissed', 'open', 'open']);
    });
  });

  describe('renderQuestions', () => {
    const base: FactoryQuestion = {
      id: 'Q-20261104-001', status: 'open', role: 'shipper', askedAt: '2026-11-04T23:12:00Z', key: 'k1',
      question: 'Q1?', context: '', answer: '',
    };

    it('round-trips through parse', () => {
      const questions: FactoryQuestion[] = [
        { ...base, issue: 498, pr: 512, idea: 'I-77aa01', context: 'line one\nline two' },
        { ...base, id: 'Q-20261104-002', status: 'answered', askedAt: '2026-11-04T23:30:00Z', key: 'k2', answer: 'Do it.\n\n- with a list' },
        { ...base, id: 'Q-20261103-001', status: 'applied', askedAt: '2026-11-03T10:00:00Z', key: 'k3', answer: 'ok' },
        { ...base, id: 'Q-20261102-001', status: 'dismissed', askedAt: '2026-11-02T10:00:00Z', key: 'k4' },
      ];
      const rendered = renderQuestions(questions);
      expect(rendered.startsWith('# Alpha Loop — questions for you\n')).toBe(true);
      expect(parseQuestions(rendered)).toEqual(questions);
      expect(renderQuestions(parseQuestions(rendered))).toBe(rendered);
    });

    it('renders the documented layout', () => {
      expect(renderQuestions(parseQuestions(SAMPLE))).toBe(SAMPLE + '\n');
    });

    it('puts open questions first, each group newest first', () => {
      const questions: FactoryQuestion[] = [
        { ...base, id: 'Q-20261101-001', status: 'applied', askedAt: '2026-11-01T00:00:00Z', answer: 'a' },
        { ...base, id: 'Q-20261102-001', askedAt: '2026-11-02T00:00:00Z' },
        { ...base, id: 'Q-20261105-001', status: 'answered', askedAt: '2026-11-05T00:00:00Z', answer: 'b' },
        { ...base, id: 'Q-20261103-001', askedAt: '2026-11-03T00:00:00Z' },
      ];
      expect(parseQuestions(renderQuestions(questions)).map((q) => q.id)).toEqual([
        'Q-20261103-001', 'Q-20261102-001', 'Q-20261105-001', 'Q-20261101-001',
      ]);
    });

    it('escapes free-text lines that look like structure', () => {
      const tricky: FactoryQuestion = {
        ...base,
        question: 'Look at this:\n## Q-20990101-001 · open · fake',
        context: '**Answer:** not really',
      };
      const parsed = parseQuestions(renderQuestions([tricky]));
      expect(parsed).toEqual([tricky]);
    });
  });

  describe('askQuestion', () => {
    const now = new Date('2026-11-05T12:34:56.789Z');

    it('creates the file and numbers ids per UTC day', () => {
      const first = askQuestion(file, NEW_Q, { now });
      expect(first.created).toBe(true);
      expect(first.question).toMatchObject({
        id: 'Q-20261105-001', status: 'open', askedAt: '2026-11-05T12:34:56Z', pr: 512, answer: '', key: 'ship:512:conflict',
      });
      const second = askQuestion(file, { ...NEW_Q, key: 'ship:513:conflict', pr: 513 }, { now });
      expect(second.question.id).toBe('Q-20261105-002');
      const nextDay = askQuestion(file, { ...NEW_Q, key: 'other' }, { now: new Date('2026-11-06T00:00:01Z') });
      expect(nextDay.question.id).toBe('Q-20261106-001');
      expect(readQuestions(file).map((q) => q.id).sort()).toEqual(['Q-20261105-001', 'Q-20261105-002', 'Q-20261106-001']);
      expect(readdirSync(join(dir, 'nested'))).toEqual(['questions.md']);
    });

    it('dedupes by key while open or answered, and allows re-asking after applied/dismissed', () => {
      const first = askQuestion(file, NEW_Q, { now });
      const again = askQuestion(file, { ...NEW_Q, question: 'reworded' }, { now });
      expect(again).toEqual({ question: first.question, created: false });
      expect(readQuestions(file)).toHaveLength(1);

      answerQuestion(file, first.question.id, 'rebase it');
      expect(askQuestion(file, NEW_Q, { now }).created).toBe(false);

      markQuestion(file, first.question.id, 'applied');
      const reasked = askQuestion(file, NEW_Q, { now });
      expect(reasked.created).toBe(true);
      expect(reasked.question.id).toBe('Q-20261105-002');

      markQuestion(file, reasked.question.id, 'dismissed');
      expect(askQuestion(file, NEW_Q, { now }).created).toBe(true);
      expect(readQuestions(file)).toHaveLength(3);
    });

    it('keeps an explicit askedAt, issue and idea', () => {
      const { question } = askQuestion(file, { role: 'pm', key: 'pm:I-1', idea: 'I-1', issue: 9, question: 'Which?', context: 'ctx', askedAt: '2026-01-01T00:00:00Z' }, { now });
      expect(readQuestions(file)).toEqual([question]);
      expect(question).toMatchObject({ askedAt: '2026-01-01T00:00:00Z', idea: 'I-1', issue: 9, context: 'ctx' });
    });

    it('preserves an answer the human saved to another question since the last read', () => {
      const { question: first } = askQuestion(file, NEW_Q, { now });
      // Human types an answer under the first question and saves.
      writeFileSync(file, readFileSync(file, 'utf-8').replace('**Answer:**\n', '**Answer:**\nYes, rebase onto master.\n'));
      askQuestion(file, { ...NEW_Q, key: 'ship:600:no-checks', pr: 600 }, { now });
      const byId = new Map(readQuestions(file).map((q) => [q.id, q]));
      expect(byId.get(first.id)).toMatchObject({ status: 'answered', answer: 'Yes, rebase onto master.' });
      expect(byId.size).toBe(2);
    });
  });

  describe('answerQuestion / markQuestion', () => {
    it('answers open questions and refuses blank answers, unknown ids and closed questions', () => {
      const { question } = askQuestion(file, NEW_Q);
      expect(answerQuestion(file, question.id, '   ')).toBe(false);
      expect(answerQuestion(file, question.id, 'TODO')).toBe(false);
      expect(answerQuestion(file, 'Q-20990101-001', 'x')).toBe(false);
      expect(answerQuestion(file, question.id, '  Merge it  ')).toBe(true);
      expect(readQuestions(file)[0]).toMatchObject({ status: 'answered', answer: 'Merge it' });
      expect(answerQuestion(file, question.id, 'Actually wait')).toBe(true);
      expect(readQuestions(file)[0].answer).toBe('Actually wait');

      expect(markQuestion(file, question.id, 'applied')).toBe(true);
      expect(readQuestions(file)[0]).toMatchObject({ status: 'applied', answer: 'Actually wait' });
      expect(answerQuestion(file, question.id, 'again')).toBe(false);
    });

    it('returns false for a missing file without creating it', () => {
      const missing = join(dir, 'missing.md');
      expect(markQuestion(missing, 'Q-20261105-001', 'dismissed')).toBe(false);
      expect(answerQuestion(missing, 'Q-20261105-001', 'x')).toBe(false);
      expect(existsSync(missing)).toBe(false);
    });

    it('preserves human edits to other questions', () => {
      const a = askQuestion(file, NEW_Q).question;
      const b = askQuestion(file, { ...NEW_Q, key: 'k-b' }).question;
      writeFileSync(file, readFileSync(file, 'utf-8').replace(`## ${a.id} · open ·`, `## ${a.id} · dismissed ·`));
      expect(answerQuestion(file, b.id, 'go')).toBe(true);
      const byId = new Map(readQuestions(file).map((q) => [q.id, q]));
      expect(byId.get(a.id)?.status).toBe('dismissed');
      expect(byId.get(b.id)).toMatchObject({ status: 'answered', answer: 'go' });
    });
  });

  describe('answeredQuestions / openQuestionCount', () => {
    it('separates questions awaiting the human from answers awaiting the supervisor', () => {
      const q = (id: string, status: FactoryQuestion['status'], answer = ''): FactoryQuestion => ({
        id, status, role: 'r', askedAt: '', key: id, question: '?', context: '', answer,
      });
      const questions = [
        q('a', 'open'),
        q('b', 'open', 'filled but not reparsed'),
        q('c', 'answered', 'yes'),
        q('d', 'applied', 'yes'),
        q('e', 'dismissed'),
        q('f', 'open', 'TODO'),
      ];
      expect(answeredQuestions(questions).map((x) => x.id)).toEqual(['b', 'c']);
      expect(openQuestionCount(questions)).toBe(2);
    });
  });
});
