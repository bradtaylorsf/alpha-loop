import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeTrace,
  writeTraceMetadata,
  readTrace,
  readTraceMetadata,
  listTraceSessions,
  listTraceIssues,
  listTraces,
  getTraceFiles,
  traceDir,
} from '../../src/lib/traces.js';
import type { TraceMetadata } from '../../src/lib/traces.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-trace-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const sampleMetadata: TraceMetadata = {
  issueNum: 42,
  title: 'Fix the widget',
  status: 'success',
  duration: 120,
  retries: 1,
  testsPassing: true,
  verifyPassing: true,
  verifySkipped: false,
  filesChanged: 3,
  prUrl: 'https://github.com/test/repo/pull/10',
  timestamp: '2026-04-01T12:00:00.000Z',
  agent: 'claude',
  model: 'opus',
};

describe('writeTrace / readTrace', () => {
  it('writes and reads a trace file', () => {
    writeTrace('session-20260401-120000', 42, 'test-output.txt', 'All tests passed', tempDir);
    const content = readTrace('session-20260401-120000', 42, 'test-output.txt', tempDir);
    expect(content).toBe('All tests passed');
  });

  it('returns null for non-existent trace', () => {
    const content = readTrace('nonexistent', 999, 'test-output.txt', tempDir);
    expect(content).toBeNull();
  });

  it('creates directory structure automatically', () => {
    writeTrace('session-20260401-120000', 42, 'diff.patch', 'diff content', tempDir);
    const dir = traceDir('session-20260401-120000', 42, tempDir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('writeTraceMetadata / readTraceMetadata', () => {
  it('writes and reads metadata', () => {
    writeTraceMetadata('session-20260401-120000', 42, sampleMetadata, tempDir);
    const metadata = readTraceMetadata('session-20260401-120000', 42, tempDir);
    expect(metadata).toEqual(sampleMetadata);
  });

  it('returns null for non-existent metadata', () => {
    expect(readTraceMetadata('nonexistent', 999, tempDir)).toBeNull();
  });
});

describe('listTraceSessions', () => {
  it('returns empty array when no traces exist', () => {
    expect(listTraceSessions(tempDir)).toEqual([]);
  });

  it('lists session directories', () => {
    writeTrace('session-20260401-120000', 1, 'metadata.json', '{}', tempDir);
    writeTrace('session-20260402-120000', 2, 'metadata.json', '{}', tempDir);
    const sessions = listTraceSessions(tempDir);
    expect(sessions).toEqual(['session-20260401-120000', 'session-20260402-120000']);
  });
});

describe('listTraceIssues', () => {
  it('returns empty array for non-existent session', () => {
    expect(listTraceIssues('nonexistent', tempDir)).toEqual([]);
  });

  it('lists issue numbers in a session', () => {
    writeTrace('session-20260401-120000', 10, 'metadata.json', '{}', tempDir);
    writeTrace('session-20260401-120000', 20, 'metadata.json', '{}', tempDir);
    const issues = listTraceIssues('session-20260401-120000', tempDir);
    expect(issues).toEqual([10, 20]);
  });
});

describe('listTraces', () => {
  it('returns all traces newest-first', () => {
    writeTraceMetadata('session-20260401-120000', 1, { ...sampleMetadata, issueNum: 1 }, tempDir);
    writeTraceMetadata('session-20260402-120000', 2, { ...sampleMetadata, issueNum: 2 }, tempDir);
    const traces = listTraces(tempDir);
    expect(traces).toHaveLength(2);
    expect(traces[0].session).toBe('session-20260402-120000');
    expect(traces[1].session).toBe('session-20260401-120000');
  });
});

describe('getTraceFiles', () => {
  it('returns empty array for non-existent trace', () => {
    expect(getTraceFiles('nonexistent', 999, tempDir)).toEqual([]);
  });

  it('lists trace files with sizes', () => {
    writeTrace('session-20260401-120000', 42, 'test-output.txt', 'test output', tempDir);
    writeTrace('session-20260401-120000', 42, 'diff.patch', 'diff content', tempDir);
    const files = getTraceFiles('session-20260401-120000', 42, tempDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.file)).toContain('test-output.txt');
    expect(files.map((f) => f.file)).toContain('diff.patch');
  });
});

describe('session name with slashes', () => {
  it('replaces slashes with dashes in directory names', () => {
    writeTrace('session/20260401-120000', 42, 'test-output.txt', 'content', tempDir);
    const dir = traceDir('session/20260401-120000', 42, tempDir);
    expect(dir).toContain('session-20260401-120000');
    expect(existsSync(dir)).toBe(true);
  });
});
