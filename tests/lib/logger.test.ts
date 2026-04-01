import { log } from '../../src/lib/logger.js';

describe('logger', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('log.info outputs INFO label', () => {
    log.info('test message');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[INFO]');
    expect(output).toContain('test message');
  });

  it('log.success outputs OK label', () => {
    log.success('done');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[OK]');
    expect(output).toContain('done');
  });

  it('log.warn outputs WARN label', () => {
    log.warn('careful');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[WARN]');
    expect(output).toContain('careful');
  });

  it('log.error outputs ERROR label', () => {
    log.error('broke');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[ERROR]');
    expect(output).toContain('broke');
  });

  it('log.step outputs STEP label', () => {
    log.step('step 1');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[STEP]');
    expect(output).toContain('step 1');
  });

  it('log.dry outputs DRY label', () => {
    log.dry('would do');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[DRY]');
    expect(output).toContain('would do');
  });

  it('log.debug outputs DEBUG label', () => {
    log.debug('detail');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('[DEBUG]');
    expect(output).toContain('detail');
  });

  it('includes a timestamp in HH:MM:SS format', () => {
    log.info('check time');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
