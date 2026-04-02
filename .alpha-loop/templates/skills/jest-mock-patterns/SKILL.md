---
name: jest-mock-patterns
description: Common Jest mocking gotchas and solutions. Document common Jest mocking pitfalls including resetMocks behavior, module mocking order, and system global mocking.
---

# Jest Mock Patterns Skill

Comprehensive guide to Jest mocking patterns, common gotchas, and solutions.

## Configuration Gotchas

### resetMocks vs clearMocks vs restoreMocks

| Option | Clears call history | Clears return values | Restores original |
|--------|--------------------|-----------------------|-------------------|
| `clearMocks` | Yes | No | No |
| `resetMocks` | Yes | **Yes** | No |
| `restoreMocks` | Yes | Yes | Yes |

**CRITICAL**: AlphaCoder uses `resetMocks: true` in Jest config!

### The resetMocks: true Gotcha

**Problem:** Mock return values are cleared between tests.

```typescript
// ❌ WRONG - Return value lost after first test
const mockGetSession = jest.fn().mockReturnValue({ id: 1, status: 'active' });
jest.mock('./session-manager', () => ({ getSession: mockGetSession }));

describe('Session tests', () => {
  it('test 1', () => {
    expect(mockGetSession()).toEqual({ id: 1, status: 'active' }); // PASS
  });

  it('test 2', () => {
    // mockGetSession now returns undefined due to resetMocks!
    expect(mockGetSession()).toEqual({ id: 1, status: 'active' }); // FAIL
  });
});
```

**Solution:** Re-set mock return values in `beforeEach`:

```typescript
// ✅ CORRECT - Reset return values each test
import { getSession } from './session-manager';
jest.mock('./session-manager');

const mockedGetSession = getSession as jest.Mock;

describe('Session tests', () => {
  beforeEach(() => {
    mockedGetSession.mockReturnValue({ id: 1, status: 'active' });
  });

  it('test 1', () => {
    expect(mockedGetSession()).toEqual({ id: 1, status: 'active' }); // PASS
  });

  it('test 2', () => {
    expect(mockedGetSession()).toEqual({ id: 1, status: 'active' }); // PASS
  });
});
```

**Alternative:** Mock factory function (called for each test):

```typescript
// ✅ ALSO CORRECT - Factory function approach
jest.mock('./session-manager', () => ({
  getSession: jest.fn(() => ({ id: 1, status: 'active' })),
}));
```

## Module Mocking Order

### Mocks MUST Be Before Imports

Jest hoists `jest.mock()` calls, but the mock factory runs at import time.

```typescript
// ✅ CORRECT ORDER
jest.mock('./database');
import { getDatabase } from './database'; // Receives mocked version

// ❌ WRONG ORDER - Import already resolved
import { getDatabase } from './database'; // Gets real version
jest.mock('./database'); // Too late!
```

### Dynamic Imports with Mocks

For complex cases, use dynamic imports:

```typescript
jest.mock('./database');

describe('tests', () => {
  let myModule: typeof import('./my-module');

  beforeEach(async () => {
    // Fresh import each test
    myModule = await import('./my-module');
  });
});
```

## Mocking System Globals

### process.kill for PID Checking

Standard pattern for testing code that checks if processes are alive:

```typescript
// Create test helpers
const originalKill = process.kill;
const deadPids = new Set<number>();

beforeEach(() => {
  deadPids.clear();
  (process.kill as jest.Mock) = jest.fn((pid: number, signal?: number) => {
    // Signal 0 = check if process exists (without killing)
    if (signal === 0 && deadPids.has(pid)) {
      const error = new Error('ESRCH: no such process');
      (error as NodeJS.ErrnoException).code = 'ESRCH';
      throw error;
    }
    return true;
  });
});

afterEach(() => {
  process.kill = originalKill;
});

// Usage in tests:
describe('Process detection', () => {
  it('returns true for alive process', () => {
    expect(isProcessAlive(12345)).toBe(true);
  });

  it('returns false for dead process', () => {
    deadPids.add(12345);
    expect(isProcessAlive(12345)).toBe(false);
  });
});
```

### process.pid

```typescript
const originalPid = process.pid;

beforeEach(() => {
  Object.defineProperty(process, 'pid', { value: 99999, writable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'pid', { value: originalPid, writable: true });
});
```

### Date/Time Mocking

```typescript
describe('Time-sensitive tests', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses mocked time', () => {
    expect(new Date().toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('can advance time', () => {
    jest.advanceTimersByTime(60000); // 1 minute
    expect(new Date().toISOString()).toBe('2025-01-01T00:01:00.000Z');
  });
});
```

### setTimeout/setInterval

```typescript
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('handles delayed callback', () => {
  const callback = jest.fn();
  setTimeout(callback, 1000);

  expect(callback).not.toHaveBeenCalled();

  jest.advanceTimersByTime(1000);

  expect(callback).toHaveBeenCalledTimes(1);
});
```

## Mocking Expensive Infrastructure

### Claude CLI / AgentSession

Avoid spawning real Claude processes ($$$):

```typescript
jest.mock('../../src/server/agent.js', () => ({
  AgentSession: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    stop: jest.fn(),
    emit: jest.fn(),
  })),
}));
```

### Session Manager

```typescript
const mockGetActiveSession = jest.fn();
const mockStartSession = jest.fn();
const mockStopSession = jest.fn();

jest.mock('../../src/server/session-manager.js', () => ({
  getActiveSession: mockGetActiveSession,
  startSession: mockStartSession,
  stopSession: mockStopSession,
  getActiveSessionCount: jest.fn().mockReturnValue(0),
}));

// In beforeEach, reset return values:
beforeEach(() => {
  mockGetActiveSession.mockReturnValue(null);
  mockStartSession.mockResolvedValue({ on: jest.fn() });
});
```

### WebSocket Broadcasting

```typescript
const mockBroadcast = jest.fn();
jest.mock('../../src/server/websocket-broadcaster.js', () => ({
  broadcast: mockBroadcast,
}));

// Verify broadcasts in tests:
expect(mockBroadcast).toHaveBeenCalledWith({
  type: 'session_started',
  payload: expect.objectContaining({
    projectId: 1,
    sessionType: 'coding',
  }),
});
```

### Database (In-Memory SQLite)

```typescript
import Database from 'better-sqlite3';

let testDb: Database.Database;

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      status TEXT DEFAULT 'pending'
    );
  `);
});

afterAll(() => {
  testDb.close();
});

// Mock getDatabase to return test db
jest.mock('../../src/server/database.js', () => ({
  getDatabase: () => testDb,
}));
```

## Spy vs Mock

### When to Use Spies

Spies observe calls to real implementations:

```typescript
// Spy on existing method - real implementation runs
const consoleSpy = jest.spyOn(console, 'log');

doSomething(); // console.log actually runs

expect(consoleSpy).toHaveBeenCalledWith('expected message');

consoleSpy.mockRestore();
```

### When to Use Mocks

Mocks replace implementations entirely:

```typescript
// Mock replaces implementation
jest.spyOn(console, 'log').mockImplementation(() => {});

doSomething(); // console.log is silenced

expect(console.log).toHaveBeenCalled();
```

## Common Patterns

### Testing Async Code

```typescript
it('handles async operations', async () => {
  mockFetch.mockResolvedValue({ data: 'result' });

  const result = await fetchData();

  expect(result).toEqual({ data: 'result' });
});

it('handles async errors', async () => {
  mockFetch.mockRejectedValue(new Error('Network error'));

  await expect(fetchData()).rejects.toThrow('Network error');
});
```

### Testing Event Emitters

```typescript
it('emits events correctly', () => {
  const mockCallback = jest.fn();
  emitter.on('event', mockCallback);

  emitter.emit('event', { data: 'test' });

  expect(mockCallback).toHaveBeenCalledWith({ data: 'test' });
});
```

### Partial Mocking

Mock only specific exports:

```typescript
jest.mock('./utils', () => ({
  ...jest.requireActual('./utils'), // Keep real implementations
  expensiveFunction: jest.fn(),      // Mock only this one
}));
```

## Troubleshooting

### Mock Not Being Applied

1. Check mock order (before imports)
2. Check mock path matches import path exactly
3. Check for `.js` extension in ESM projects

### Mock Return Value Undefined

1. Check if `resetMocks: true` in Jest config
2. Add return value in `beforeEach`

### Tests Pass Individually, Fail Together

1. Mock state leaking between tests
2. Missing cleanup in `afterEach`
3. Shared mutable state

### Timeout Errors

1. Missing `await` on async operations
2. Unresolved promises in mocked functions
3. `useFakeTimers()` blocking real timers

## Reference

- Jest Mocking: https://jestjs.io/docs/mock-functions
- Jest Timer Mocks: https://jestjs.io/docs/timer-mocks
- Jest ES6 Mocks: https://jestjs.io/docs/es6-class-mocks
