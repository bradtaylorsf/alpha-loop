jest.mock('node:os', () => ({
  platform: jest.fn(),
  arch: jest.fn(),
  cpus: jest.fn(),
  totalmem: jest.fn(),
}));

import * as os from 'node:os';
import {
  detectAppleSilicon,
  getTotalMemoryGB,
  shouldOfferLocalMode,
} from '../../src/lib/hardware';

const mockedPlatform = os.platform as jest.MockedFunction<typeof os.platform>;
const mockedArch = os.arch as jest.MockedFunction<typeof os.arch>;
const mockedCpus = os.cpus as jest.MockedFunction<typeof os.cpus>;
const mockedTotalmem = os.totalmem as jest.MockedFunction<typeof os.totalmem>;

function setHardware(opts: {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  cpuModel?: string;
  memGB?: number;
}): void {
  mockedPlatform.mockReturnValue(opts.platform ?? 'darwin');
  mockedArch.mockReturnValue(opts.arch ?? 'arm64');
  mockedCpus.mockReturnValue([
    {
      model: opts.cpuModel ?? 'Apple M4 Max',
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    },
  ]);
  mockedTotalmem.mockReturnValue(Math.round((opts.memGB ?? 128) * 1024 ** 3));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('detectAppleSilicon', () => {
  it('returns true on darwin arm64 with Apple M-series CPU', () => {
    setHardware({ cpuModel: 'Apple M3 Max' });
    expect(detectAppleSilicon()).toBe(true);
  });

  it('matches M1, M2, M3, M4 variants', () => {
    for (const model of ['Apple M1', 'Apple M2 Pro', 'Apple M3 Ultra', 'Apple M4 Max']) {
      setHardware({ cpuModel: model });
      expect(detectAppleSilicon()).toBe(true);
    }
  });

  it('returns false on darwin x86_64 (Intel Mac)', () => {
    setHardware({ arch: 'x64', cpuModel: 'Intel(R) Core(TM) i9' });
    expect(detectAppleSilicon()).toBe(false);
  });

  it('returns false on linux arm64', () => {
    setHardware({ platform: 'linux', cpuModel: 'Apple M1' });
    expect(detectAppleSilicon()).toBe(false);
  });

  it('returns false on windows', () => {
    setHardware({ platform: 'win32', arch: 'x64' });
    expect(detectAppleSilicon()).toBe(false);
  });

  it('returns false when arm64 but cpu model is not Apple M-series', () => {
    setHardware({ cpuModel: 'ARM Cortex-A78' });
    expect(detectAppleSilicon()).toBe(false);
  });

  it('returns false when cpus() is empty', () => {
    mockedPlatform.mockReturnValue('darwin');
    mockedArch.mockReturnValue('arm64');
    mockedCpus.mockReturnValue([]);
    expect(detectAppleSilicon()).toBe(false);
  });
});

describe('getTotalMemoryGB', () => {
  it('converts bytes to gibibytes', () => {
    mockedTotalmem.mockReturnValue(128 * 1024 ** 3);
    expect(getTotalMemoryGB()).toBeCloseTo(128, 5);
  });

  it('returns fractional GB for non-power-of-two sizes', () => {
    mockedTotalmem.mockReturnValue(48 * 1024 ** 3);
    expect(getTotalMemoryGB()).toBeCloseTo(48, 5);
  });
});

describe('shouldOfferLocalMode', () => {
  it('returns true on Apple Silicon with 128GB', () => {
    setHardware({ cpuModel: 'Apple M4 Max', memGB: 128 });
    expect(shouldOfferLocalMode()).toBe(true);
  });

  it('returns true on Apple Silicon with exactly 64GB', () => {
    setHardware({ cpuModel: 'Apple M3 Max', memGB: 64 });
    expect(shouldOfferLocalMode()).toBe(true);
  });

  it('returns false on Apple Silicon with 32GB (below threshold)', () => {
    setHardware({ cpuModel: 'Apple M2 Max', memGB: 32 });
    expect(shouldOfferLocalMode()).toBe(false);
  });

  it('returns false on Apple Silicon with 16GB', () => {
    setHardware({ cpuModel: 'Apple M1', memGB: 16 });
    expect(shouldOfferLocalMode()).toBe(false);
  });

  it('returns false on x86_64 Mac even with 128GB', () => {
    setHardware({ arch: 'x64', cpuModel: 'Intel Xeon W', memGB: 128 });
    expect(shouldOfferLocalMode()).toBe(false);
  });

  it('returns false on Linux arm64 even with 128GB', () => {
    setHardware({ platform: 'linux', cpuModel: 'Apple M1', memGB: 128 });
    expect(shouldOfferLocalMode()).toBe(false);
  });
});
