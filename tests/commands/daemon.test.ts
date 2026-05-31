jest.mock('../../src/commands/triage', () => ({
  triageCommand: jest.fn(),
}));

import { parseFeedbackPollOutput } from '../../src/commands/daemon.js';

describe('daemon command feedback polling', () => {
  it('parses NDJSON feedback poll output', () => {
    const payloads = parseFeedbackPollOutput([
      '{"repo":"owner/repo","issue":1,"source":"slack","body":"Approved"}',
      '{"repo":"owner/repo","issue":2,"source":"teams","body":"Please change the copy"}',
    ].join('\n'));

    expect(payloads).toEqual([
      expect.objectContaining({ issue: 1, body: 'Approved' }),
      expect.objectContaining({ issue: 2, body: 'Please change the copy' }),
    ]);
  });
});
