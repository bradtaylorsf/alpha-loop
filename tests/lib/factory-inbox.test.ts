import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendIdea,
  ensureInboxFile,
  ideaIdFor,
  nextPendingIdeas,
  parseInbox,
  readInbox,
  recoverTakenIdeas,
  updateIdea,
} from '../../src/lib/factory-inbox.js';

const SAMPLE = [
  '# Alpha Loop ideas inbox',
  'Drop rough ideas below as `- [ ] ...` bullets. The factory PM turns each into issues.',
  '',
  '- [ ] Let the shipper auto-rebase stale PRs',
  '- [~] Something the PM is working on  <!-- factory:id=I-3f2a1c taken=2026-11-04T23:10:00Z -->',
  '- [x] Done idea → #512, #513  <!-- factory:id=I-9b1e22 -->',
  '- [?] Ambiguous idea → Q-20261104-002  <!-- factory:id=I-77aa01 -->',
  '- [-] Rejected/duplicate idea → dup of #300  <!-- factory:id=I-0c0c0c -->',
  '',
].join('\n');

describe('factory-inbox', () => {
  let dir: string;
  let inbox: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-inbox-'));
    inbox = join(dir, 'nested', 'inbox.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseInbox', () => {
    it('parses every status, note, tag id and meta', () => {
      const ideas = parseInbox(SAMPLE);
      expect(ideas.map((i) => [i.status, i.text, i.note, i.line])).toEqual([
        ['pending', 'Let the shipper auto-rebase stale PRs', '', 3],
        ['taken', 'Something the PM is working on', '', 4],
        ['done', 'Done idea', '#512, #513', 5],
        ['question', 'Ambiguous idea', 'Q-20261104-002', 6],
        ['rejected', 'Rejected/duplicate idea', 'dup of #300', 7],
      ]);
      expect(ideas[0].id).toBe(ideaIdFor('Let the shipper auto-rebase stale PRs'));
      expect(ideas[1]).toMatchObject({ id: 'I-3f2a1c', meta: { taken: '2026-11-04T23:10:00Z' } });
      expect(ideas[2].id).toBe('I-9b1e22');
      expect(ideas[2].meta).toEqual({});
    });

    it('ignores non-checkbox bullets, empty checkboxes and fenced code', () => {
      const ideas = parseInbox([
        '- plain bullet',
        '- [ ]',
        '```',
        '- [ ] example inside a code fence',
        '```',
        '* [X] star bullet with capital X  <!-- factory:id=I-aaaaaa -->',
      ].join('\n'));
      expect(ideas).toHaveLength(1);
      expect(ideas[0]).toMatchObject({ id: 'I-aaaaaa', status: 'done', text: 'star bullet with capital X' });
    });

    it('joins indented continuation lines into the idea text and stops at a blank line', () => {
      const ideas = parseInbox([
        '- [ ] Build a dashboard',
        '  with a live queue view',
        '\tand a tab-indented detail',
        '',
        '  not a continuation after the blank line',
        '- [ ] Second idea',
      ].join('\n'));
      expect(ideas.map((i) => i.text)).toEqual([
        'Build a dashboard\nwith a live queue view\nand a tab-indented detail',
        'Second idea',
      ]);
    });

    it('keeps a human-typed arrow in untagged text instead of reading it as a note', () => {
      const [idea] = parseInbox('- [ ] Move A → B');
      expect(idea.text).toBe('Move A → B');
      expect(idea.note).toBe('');
    });
  });

  describe('ideaIdFor', () => {
    it('is stable across whitespace and case and has the I-xxxxxx shape', () => {
      const id = ideaIdFor('Let the shipper  auto-rebase\nstale PRs');
      expect(id).toMatch(/^I-[0-9a-f]{6}$/);
      expect(ideaIdFor('  let the SHIPPER auto-rebase stale prs ')).toBe(id);
      expect(ideaIdFor('something else')).not.toBe(id);
    });

    it('gives untagged ideas the same id on every parse', () => {
      const first = parseInbox(SAMPLE)[0].id;
      const edited = SAMPLE.replace('# Alpha Loop ideas inbox', '# My inbox\n\nSome new prose.');
      expect(parseInbox(edited)[0].id).toBe(first);
    });
  });

  describe('ensureInboxFile / readInbox', () => {
    it('creates the file with the header (mkdir -p) and leaves an existing file alone', () => {
      expect(readInbox(inbox)).toEqual([]);
      ensureInboxFile(inbox);
      const created = readFileSync(inbox, 'utf-8');
      expect(created).toContain('# Alpha Loop ideas inbox');
      expect(created).toContain('Drop rough ideas below');
      expect(readInbox(inbox)).toEqual([]);

      writeFileSync(inbox, SAMPLE);
      ensureInboxFile(inbox);
      expect(readFileSync(inbox, 'utf-8')).toBe(SAMPLE);
    });
  });

  describe('appendIdea', () => {
    it('appends a tagged pending bullet and returns it', () => {
      const idea = appendIdea(inbox, '  Add a retry button  ');
      expect(idea).toMatchObject({ status: 'pending', text: 'Add a retry button', note: '' });
      expect(idea.id).toBe(ideaIdFor('Add a retry button'));
      expect(readInbox(inbox)).toEqual([idea]);
      expect(readFileSync(inbox, 'utf-8')).toContain(`- [ ] Add a retry button  <!-- factory:id=${idea.id} -->\n`);
    });

    it('writes multi-line text as continuation lines', () => {
      const idea = appendIdea(inbox, 'First line\nsecond line\n\n  third line');
      expect(idea.text).toBe('First line\nsecond line\nthird line');
      const content = readFileSync(inbox, 'utf-8');
      expect(content).toContain('- [ ] First line  <!-- factory:id=');
      expect(content).toContain('\n  second line\n  third line\n');
      expect(readInbox(inbox)).toEqual([idea]);
    });

    it('gives identical texts distinct ids', () => {
      const a = appendIdea(inbox, 'Same idea');
      const b = appendIdea(inbox, 'Same idea');
      expect(a.id).not.toBe(b.id);
      expect(readInbox(inbox).map((i) => i.id)).toEqual([a.id, b.id]);
    });

    it('preserves existing content and rejects empty text', () => {
      ensureInboxFile(inbox);
      writeFileSync(inbox, SAMPLE);
      appendIdea(inbox, 'New idea');
      const content = readFileSync(inbox, 'utf-8');
      expect(content.startsWith(SAMPLE.trimEnd())).toBe(true);
      expect(readInbox(inbox)).toHaveLength(6);
      expect(() => appendIdea(inbox, '  \n ')).toThrow('empty');
    });
  });

  describe('updateIdea', () => {
    beforeEach(() => {
      ensureInboxFile(inbox);
      writeFileSync(inbox, SAMPLE);
    });

    it('walks an untagged idea through taken → done, tagging it with its computed id', () => {
      const id = ideaIdFor('Let the shipper auto-rebase stale PRs');
      expect(updateIdea(inbox, id, { status: 'taken', meta: { taken: '2026-11-05T01:00:00Z' } })).toBe(true);
      let lines = readFileSync(inbox, 'utf-8').split('\n');
      expect(lines[3]).toBe(`- [~] Let the shipper auto-rebase stale PRs  <!-- factory:id=${id} taken=2026-11-05T01:00:00Z -->`);

      expect(updateIdea(inbox, id, { status: 'done', note: '#600, #601' })).toBe(true);
      lines = readFileSync(inbox, 'utf-8').split('\n');
      expect(lines[3]).toBe(`- [x] Let the shipper auto-rebase stale PRs → #600, #601  <!-- factory:id=${id} -->`);
      const idea = readInbox(inbox).find((i) => i.id === id);
      expect(idea).toMatchObject({ status: 'done', note: '#600, #601', text: 'Let the shipper auto-rebase stale PRs', meta: {} });
    });

    it('rewrites only the target bullet and keeps everything else byte-for-byte', () => {
      updateIdea(inbox, 'I-77aa01', { status: 'pending', note: '' });
      const before = SAMPLE.split('\n');
      const after = readFileSync(inbox, 'utf-8').split('\n');
      expect(after).toHaveLength(before.length);
      after.forEach((line, index) => {
        if (index === 6) expect(line).toBe('- [ ] Ambiguous idea  <!-- factory:id=I-77aa01 -->');
        else expect(line).toBe(before[index]);
      });
    });

    it('supports question and rejected transitions and keeps the note when omitted', () => {
      updateIdea(inbox, 'I-3f2a1c', { status: 'question', note: 'Q-20261105-001' });
      updateIdea(inbox, 'I-0c0c0c', { status: 'rejected' });
      const byId = new Map(readInbox(inbox).map((i) => [i.id, i]));
      expect(byId.get('I-3f2a1c')).toMatchObject({ status: 'question', note: 'Q-20261105-001', meta: {} });
      expect(byId.get('I-0c0c0c')).toMatchObject({ status: 'rejected', note: 'dup of #300' });
    });

    it('stamps a taken time when none is given', () => {
      const id = ideaIdFor('Let the shipper auto-rebase stale PRs');
      updateIdea(inbox, id, { status: 'taken' });
      const idea = readInbox(inbox).find((i) => i.id === id);
      expect(idea?.meta.taken).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('keeps continuation lines under the rewritten bullet', () => {
      writeFileSync(inbox, '- [ ] Multi\n  line idea\n- [ ] Other\n');
      const id = ideaIdFor('Multi\nline idea');
      expect(updateIdea(inbox, id, { status: 'taken', meta: { taken: '2026-11-05T00:00:00Z' } })).toBe(true);
      expect(readFileSync(inbox, 'utf-8')).toBe(
        `- [~] Multi  <!-- factory:id=${id} taken=2026-11-05T00:00:00Z -->\n  line idea\n- [ ] Other\n`,
      );
      expect(readInbox(inbox)[0]).toMatchObject({ id, text: 'Multi\nline idea', status: 'taken' });
    });

    it('re-reads the file so a human edit saved since the last read survives', () => {
      const ideas = readInbox(inbox);
      // Human adds an idea and edits prose after the supervisor read the file.
      writeFileSync(inbox, SAMPLE.replace('Drop rough ideas', 'PLEASE drop rough ideas') + '- [ ] Human-added idea\n');
      expect(updateIdea(inbox, ideas[1].id, { status: 'done', note: '#700' })).toBe(true);
      const content = readFileSync(inbox, 'utf-8');
      expect(content).toContain('PLEASE drop rough ideas');
      expect(content).toContain('- [ ] Human-added idea');
      expect(content).toContain('- [x] Something the PM is working on → #700  <!-- factory:id=I-3f2a1c -->');
    });

    it('preserves CRLF line endings', () => {
      writeFileSync(inbox, SAMPLE.replace(/\n/g, '\r\n'));
      updateIdea(inbox, 'I-9b1e22', { status: 'done', note: '#1' });
      const content = readFileSync(inbox, 'utf-8');
      expect(content.split('\r\n')[5]).toBe('- [x] Done idea → #1  <!-- factory:id=I-9b1e22 -->');
      expect(content.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('neutralizes an arrow in text once tagged so the text survives a round trip', () => {
      writeFileSync(inbox, '- [ ] Move A → B\n');
      const id = ideaIdFor('Move A → B');
      updateIdea(inbox, id, { status: 'taken', meta: { taken: '2026-11-05T00:00:00Z' } });
      expect(readInbox(inbox)[0]).toMatchObject({ id, text: 'Move A -> B', note: '' });
    });

    it('returns false for a missing file or id and leaves no temp files behind', () => {
      expect(updateIdea(join(dir, 'missing.md'), 'I-000000', { status: 'done' })).toBe(false);
      expect(updateIdea(inbox, 'I-ffffff', { status: 'done' })).toBe(false);
      updateIdea(inbox, 'I-9b1e22', { status: 'done', note: '#2' });
      expect(readdirSync(join(dir, 'nested'))).toEqual(['inbox.md']);
    });
  });

  describe('nextPendingIdeas', () => {
    it('returns pending ideas in file order up to the limit', () => {
      const ideas = parseInbox(SAMPLE + '- [ ] Another\n- [ ] Third\n');
      expect(nextPendingIdeas(ideas, 2).map((i) => i.text)).toEqual(['Let the shipper auto-rebase stale PRs', 'Another']);
      expect(nextPendingIdeas(ideas, 10)).toHaveLength(3);
      expect(nextPendingIdeas(ideas, 0)).toEqual([]);
    });
  });

  describe('recoverTakenIdeas', () => {
    it('returns stale taken ideas to pending and leaves fresh ones', () => {
      ensureInboxFile(inbox);
      writeFileSync(inbox, [
        '- [~] Stale  <!-- factory:id=I-111111 taken=2026-11-05T00:00:00Z -->',
        '- [~] Fresh  <!-- factory:id=I-222222 taken=2026-11-05T00:50:00Z -->',
        '- [~] No stamp  <!-- factory:id=I-333333 -->',
        '- [x] Done → #1  <!-- factory:id=I-444444 -->',
        '',
      ].join('\n'));
      const now = new Date('2026-11-05T01:00:00Z');
      expect(recoverTakenIdeas(inbox, { olderThanMinutes: 30, now })).toEqual(['I-111111', 'I-333333']);

      const byId = new Map(readInbox(inbox).map((i) => [i.id, i]));
      expect(byId.get('I-111111')).toMatchObject({ status: 'pending', meta: {} });
      expect(byId.get('I-222222')).toMatchObject({ status: 'taken', meta: { taken: '2026-11-05T00:50:00Z' } });
      expect(byId.get('I-333333')).toMatchObject({ status: 'pending' });
      expect(byId.get('I-444444')).toMatchObject({ status: 'done', note: '#1' });

      expect(recoverTakenIdeas(inbox, { olderThanMinutes: 30, now })).toEqual([]);
    });

    it('returns [] for a missing file without creating it', () => {
      const missing = join(dir, 'none.md');
      expect(recoverTakenIdeas(missing, { olderThanMinutes: 1 })).toEqual([]);
      expect(existsSync(missing)).toBe(false);
    });
  });
  describe('duplicate ideas (regression)', () => {
    it('gives identical untagged bullets distinct ids, using the appendIdea #n scheme', () => {
      const ideas = parseInbox('- [ ] Add dark mode\n- [ ] Add dark mode\n- [ ] add  DARK mode\n');
      expect(ideas[0].id).toBe(ideaIdFor('Add dark mode'));
      expect(ideas[1].id).toBe(ideaIdFor('Add dark mode\n#2'));
      expect(ideas[2].id).toBe(ideaIdFor('add  DARK mode\n#3'));
      expect(new Set(ideas.map((i) => i.id)).size).toBe(3);
    });

    it('a retyped copy of a tagged idea gets its own id, even when the tagged line comes later', () => {
      const tagged = ideaIdFor('Add dark mode');
      const ideas = parseInbox(`- [ ] Add dark mode\n- [x] Add dark mode  <!-- factory:id=${tagged} -->\n`);
      expect(ideas[1].id).toBe(tagged);
      expect(ideas[0].id).not.toBe(tagged);
    });

    it('a copied tag line is disambiguated so updates reach the right bullet', () => {
      const path = join(dir, 'copy.md');
      writeFileSync(path, '- [x] Ship it  <!-- factory:id=I-abcdef -->\n- [ ] Ship it  <!-- factory:id=I-abcdef -->\n');
      const [first, second] = readInbox(path);
      expect(first.id).toBe('I-abcdef');
      expect(second.id).not.toBe('I-abcdef');
      expect(updateIdea(path, second.id, { status: 'taken' }, { line: second.line })).toBe(true);
      const after = readInbox(path);
      expect(after.map((i) => i.status)).toEqual(['done', 'taken']);
    });

    it('updating each copy of a duplicated bullet changes only that copy', () => {
      ensureInboxFile(inbox);
      writeFileSync(inbox, '- [ ] Add dark mode\n- [ ] Add dark mode\n');
      for (let i = 0; i < 2; i++) {
        const [next] = nextPendingIdeas(readInbox(inbox), 1);
        expect(updateIdea(inbox, next.id, { status: 'done' }, { line: next.line })).toBe(true);
      }
      expect(readInbox(inbox).map((i) => i.status)).toEqual(['done', 'done']);
      expect(nextPendingIdeas(readInbox(inbox), 1)).toEqual([]);
    });
  });

  describe('recoverTakenIdeas with a recorded PM worker', () => {
    const NOW2 = new Date('2026-11-05T10:00:00Z');
    function write(meta: string): void {
      ensureInboxFile(inbox);
      writeFileSync(inbox, `- [~] Idea  <!-- factory:id=I-111111 taken=2026-11-05T09:59:00Z ${meta} -->\n`);
    }

    it('frees a fresh idea at once when its worker pid on this host is dead, and drops the worker meta', () => {
      write(`pid=123 host=${hostname()} worker=pm-x`);
      expect(recoverTakenIdeas(inbox, { olderThanMinutes: 30, now: NOW2, isPidAlive: () => false })).toEqual(['I-111111']);
      const [idea] = readInbox(inbox);
      expect(idea.status).toBe('pending');
      expect(idea.meta).toEqual({});
    });

    it('keeps an old idea taken while its worker pid is alive', () => {
      write(`pid=123 host=${hostname()}`);
      const later = new Date(NOW2.getTime() + 3 * 3_600_000);
      expect(recoverTakenIdeas(inbox, { olderThanMinutes: 30, now: later, isPidAlive: () => true })).toEqual([]);
    });

    it('never touches skipped ids', () => {
      write('');
      const later = new Date(NOW2.getTime() + 3 * 3_600_000);
      expect(recoverTakenIdeas(inbox, { olderThanMinutes: 30, now: later, skipIds: ['I-111111'] })).toEqual([]);
    });
  });
});
