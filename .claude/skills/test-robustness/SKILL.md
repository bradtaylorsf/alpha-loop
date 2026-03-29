---
name: test-robustness
description: Comprehensive patterns for writing robust non-brittle tests including eliminating waitForTimeout, mocking time properly, and generating unique test data. Use when writing any tests to ensure fast reliable maintainable test suites.
---

# Test Robustness Skill

Comprehensive guide for writing robust, non-brittle tests that are fast, reliable, and maintainable.

## Critical Anti-Patterns to AVOID

### 1. ❌ Fixed Time Delays (`waitForTimeout`)

**NEVER use `page.waitForTimeout()` or arbitrary delays in tests.**

```typescript
// ❌ BRITTLE - Do NOT do this
await page.click('[data-testid="submit"]');
await page.waitForTimeout(1000); // Flaky! May be too short or unnecessarily long
expect(page.locator('.success')).toBeVisible();

// ❌ BRITTLE - Another bad example
await page.fill('#username', 'test');
await page.waitForTimeout(500); // Why 500ms? What are we waiting for?
await page.click('#submit');

// ✅ ROBUST - Do this instead
await page.click('[data-testid="submit"]');
await page.waitForSelector('.success', { state: 'visible' });
expect(page.locator('.success')).toBeVisible();

// ✅ ROBUST - Wait for specific condition
await page.fill('#username', 'test');
await expect(page.locator('#submit')).toBeEnabled();
await page.click('#submit');
```

**Why this is bad:**
- **Flaky**: May be too short on slow CI servers, causing random failures
- **Slow**: May be unnecessarily long on fast machines, wasting time
- **Unclear**: Doesn't express what you're actually waiting for
- **Brittle**: Breaks when timing changes (network, CPU, etc.)

**What to use instead:**
- `page.waitForSelector()` - Wait for element to appear
- `page.waitForResponse()` - Wait for specific network request
- `page.waitForNavigation()` - Wait for page navigation
- `expect().toBeVisible()` - Assert element is visible (auto-waits)
- `expect().toHaveText()` - Assert text content (auto-waits)

---

### 2. ❌ Real Time Delays in Tests (`setTimeout`)

**NEVER use real timers in tests that check time-dependent behavior.**

```typescript
// ❌ BRITTLE - Do NOT do this (adds 1.1 seconds to test!)
it('timestamps should be recent', async () => {
  const timestamp1 = Date.now();
  setTimeout(() => {
    const timestamp2 = Date.now();
    expect(timestamp2).toBeGreaterThan(timestamp1);
  }, 1100); // Slows test by 1.1 seconds!
});

// ✅ ROBUST - Mock time instead (instant!)
it('timestamps should be recent', async () => {
  jest.useFakeTimers();
  const timestamp1 = Date.now();

  jest.advanceTimersByTime(1100);

  const timestamp2 = Date.now();
  expect(timestamp2).toBeGreaterThan(timestamp1);

  jest.useRealTimers();
});
```

**Why this is bad:**
- **Slow**: Tests take actual real-world time to run (6.6 seconds wasted in our codebase!)
- **Flaky**: Can fail on slow machines or under load
- **Unnecessary**: Time can be mocked to run instantly

**What to use instead:**
- `jest.useFakeTimers()` - Mock all timer functions
- `jest.advanceTimersByTime(ms)` - Move time forward instantly
- `jest.runAllTimers()` - Run all pending timers
- `jest.useRealTimers()` - Restore real timers after test

See: `tests/helpers/time-helpers.ts` for reusable utilities.

---

### 3. ❌ Hard-Coded Test Data

**NEVER use hard-coded IDs, names, or data that could conflict between tests.**

```typescript
// ❌ BRITTLE - Hard-coded data causes conflicts
it('creates session', async () => {
  await createSession('my-session'); // What if another test uses this name?
  const session = await getSession('my-session');
  expect(session.name).toBe('my-session');
});

// ❌ BRITTLE - Hard-coded IDs
it('deletes session', async () => {
  await deleteSession('session-123'); // Assumes this ID exists!
});

// ✅ ROBUST - Use templates with unique suffixes
import { createUniqueSession } from '../helpers/seed-data';

it('creates session', async () => {
  const sessionName = createUniqueSession('my-session'); // 'my-session-1671234567890'
  await createSession(sessionName);
  const session = await getSession(sessionName);
  expect(session.name).toBe(sessionName);
});

// ✅ ROBUST - Create data in test setup
it('deletes session', async () => {
  const session = await createSession(createUniqueSession('test'));
  await deleteSession(session.id);
  await expect(getSession(session.id)).rejects.toThrow();
});
```

**Why this is bad:**
- **Test Interference**: Tests can conflict when run in parallel
- **Fragile**: Breaks if database is cleared or data changes
- **Hard to Debug**: Failures don't indicate what data was expected
- **Not Repeatable**: Tests may pass/fail depending on order

**What to use instead:**
- Template-based data with unique suffixes (timestamps, UUIDs)
- Test setup/teardown to create/destroy data
- Database transactions (rollback after test)
- In-memory databases for unit tests

See: `tests/helpers/seed-data.ts` for data generation utilities.

---

### 4. ❌ Inconsistent Uniqueness Strategies

**Use a CONSISTENT strategy for generating unique test data.**

```typescript
// ❌ INCONSISTENT - Different strategies in different tests
it('test 1', async () => {
  const name = `session-${Date.now()}`; // Uses timestamp
});

it('test 2', async () => {
  const name = 'session-' + Math.random(); // Uses random number
});

it('test 3', async () => {
  const name = 'session-test'; // No uniqueness at all!
});

// ✅ CONSISTENT - Use shared utility
import { uniqueSessionName } from '../helpers/seed-data';

it('test 1', async () => {
  const name = uniqueSessionName('session'); // session-1671234567890
});

it('test 2', async () => {
  const name = uniqueSessionName('session'); // session-1671234567891
});

it('test 3', async () => {
  const name = uniqueSessionName('session'); // session-1671234567892
});
```

**Why this is bad:**
- **Hard to Maintain**: Every test does it differently
- **Potential Collisions**: Different strategies may conflict
- **Unclear Intent**: Hard to understand the pattern
- **Duplication**: Same logic repeated everywhere

**What to use instead:**
- Single utility function: `uniqueSessionName(prefix)`
- Consistent format: `${prefix}-${timestamp}` or `${prefix}-${uuid}`
- Centralized in test helpers

---

## Correct Patterns to USE

### ✅ Wait for Specific Elements

```typescript
// Wait for element to appear
await page.waitForSelector('[data-testid="success-message"]', {
  state: 'visible'
});

// Wait for element to disappear
await page.waitForSelector('[data-testid="loading-spinner"]', {
  state: 'hidden'
});

// Wait for element to be enabled
await page.waitForSelector('[data-testid="submit-button"]:not([disabled])');

// Playwright assertions (auto-wait built-in)
await expect(page.locator('[data-testid="result"]')).toBeVisible();
await expect(page.locator('[data-testid="result"]')).toHaveText('Success');
await expect(page.locator('[data-testid="input"]')).toBeEnabled();
```

---

### ✅ Wait for Network Activity

```typescript
// Wait for specific API response
const responsePromise = page.waitForResponse(
  response => response.url().includes('/api/session') && response.status() === 200
);

await page.click('[data-testid="create-session"]');
const response = await responsePromise;
const data = await response.json();

expect(data.id).toBeDefined();

// Wait for multiple requests to complete
await Promise.all([
  page.waitForResponse('/api/session'),
  page.waitForResponse('/api/features'),
  page.click('[data-testid="load-data"]')
]);

// Wait for navigation
await Promise.all([
  page.waitForNavigation(),
  page.click('[data-testid="logout"]')
]);
```

---

### ✅ Mock Time Properly

```typescript
import { useFakeTimers, advanceTime, useRealTimers } from '../helpers/time-helpers';

it('session expires after 1 hour', async () => {
  useFakeTimers(); // Mock Date.now(), setTimeout, setInterval

  const session = await createSession('test');
  expect(session.expiresAt).toBe(Date.now() + 3600000); // 1 hour

  advanceTime(3600001); // Advance 1 hour + 1ms

  const expired = await isSessionExpired(session.id);
  expect(expired).toBe(true);

  useRealTimers(); // Restore real timers
});

it('retries after 5 seconds', async () => {
  useFakeTimers();

  const retryPromise = retryOperation(); // Returns after 5s timeout

  advanceTime(5000); // Instantly "wait" 5 seconds

  await expect(retryPromise).resolves.toBe('success');

  useRealTimers();
});
```

---

### ✅ Generate Unique Test Data

```typescript
// Use template-based seed data
import { seedSession, seedFeature, seedProject } from '../helpers/seed-data';

it('creates session with unique data', async () => {
  // Use .alphacoder paths to avoid /tmp permission issues
  const sessionData = seedSession({
    projectPath: '.alphacoder/sessions/test-data/test-project'
  });

  // sessionData = {
  //   id: 'session-1671234567890',
  //   projectPath: '.alphacoder/sessions/test-data/test-project',
  //   features: [...],
  //   createdAt: 1671234567890
  // }

  const session = await createSession(sessionData);
  expect(session.id).toBe(sessionData.id);
});

it('creates multiple sessions without conflicts', async () => {
  const session1 = seedSession();
  const session2 = seedSession();

  expect(session1.id).not.toBe(session2.id); // Different IDs

  await createSession(session1);
  await createSession(session2); // No conflicts!
});
```

---

## Helper Utilities

### Wait Helpers (`tests/helpers/wait-helpers.ts`)

```typescript
import { Page } from '@playwright/test';

/**
 * Wait for element to be visible and enabled
 */
export async function waitForInteractive(page: Page, selector: string) {
  await page.waitForSelector(selector, { state: 'visible' });
  await page.waitForSelector(`${selector}:not([disabled])`);
}

/**
 * Wait for loading spinner to disappear
 */
export async function waitForLoadingComplete(page: Page) {
  await page.waitForSelector('[data-testid="loading"]', { state: 'hidden' });
}

/**
 * Wait for API call to complete
 */
export async function waitForApiResponse(page: Page, urlPattern: string) {
  return page.waitForResponse(
    response => response.url().includes(urlPattern) && response.ok()
  );
}

/**
 * Wait for navigation and page load
 */
export async function waitForPageLoad(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle');
}
```

### Time Helpers (`tests/helpers/time-helpers.ts`)

```typescript
/**
 * Enable fake timers for testing time-dependent code
 */
export function useFakeTimers() {
  jest.useFakeTimers();
}

/**
 * Advance time by milliseconds (instant)
 */
export function advanceTime(ms: number) {
  jest.advanceTimersByTime(ms);
}

/**
 * Run all pending timers
 */
export function runAllTimers() {
  jest.runAllTimers();
}

/**
 * Restore real timers
 */
export function useRealTimers() {
  jest.useRealTimers();
}

/**
 * Mock Date.now() to return specific timestamp
 */
export function mockNow(timestamp: number) {
  jest.spyOn(Date, 'now').mockReturnValue(timestamp);
}

/**
 * Restore original Date.now()
 */
export function restoreNow() {
  jest.spyOn(Date, 'now').mockRestore();
}
```

### Seed Data (`tests/helpers/seed-data.ts`)

```typescript
let counter = 0;

/**
 * Generate unique ID
 */
export function uniqueId(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${counter++}`;
}

/**
 * Generate unique session name
 */
export function uniqueSessionName(prefix = 'session'): string {
  return uniqueId(prefix);
}

/**
 * Create session seed data with defaults
 * Uses .alphacoder paths to avoid /tmp permission issues
 */
export function seedSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: uniqueId('session'),
    projectPath: `.alphacoder/sessions/test-data/test-${uniqueId()}`,
    features: [],
    createdAt: Date.now(),
    status: 'initializing',
    ...overrides
  };
}

/**
 * Create feature seed data with defaults
 */
export function seedFeature(overrides: Partial<FeatureData> = {}): FeatureData {
  return {
    id: uniqueId('feature'),
    name: `Test Feature ${counter}`,
    description: 'Test feature description',
    status: 'pending',
    ...overrides
  };
}

/**
 * Create project seed data with defaults
 * Uses .alphacoder paths to avoid /tmp permission issues
 */
export function seedProject(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    id: uniqueId('project'),
    name: `Test Project ${counter}`,
    path: `.alphacoder/sessions/test-data/project-${uniqueId()}`,
    ...overrides
  };
}
```

---

## Before/After Examples

### Example 1: Button Click and Response

**❌ BRITTLE**
```typescript
it('shows success message', async () => {
  await page.click('[data-testid="submit"]');
  await page.waitForTimeout(1000); // Arbitrary delay!

  const message = await page.textContent('.message');
  expect(message).toBe('Success');
});
```

**✅ ROBUST**
```typescript
it('shows success message', async () => {
  await page.click('[data-testid="submit"]');

  // Wait for specific element
  await page.waitForSelector('.message', { state: 'visible' });

  // Or use auto-waiting assertion
  await expect(page.locator('.message')).toHaveText('Success');
});
```

---

### Example 2: Form Validation

**❌ BRITTLE**
```typescript
it('validates email', async () => {
  await page.fill('#email', 'invalid');
  await page.click('#submit');
  await page.waitForTimeout(500); // What are we waiting for?

  expect(await page.textContent('.error')).toContain('Invalid email');
});
```

**✅ ROBUST**
```typescript
it('validates email', async () => {
  await page.fill('#email', 'invalid');
  await page.click('#submit');

  // Wait for error message to appear
  await expect(page.locator('.error')).toContainText('Invalid email');
});
```

---

### Example 3: Time-Based Logic

**❌ BRITTLE**
```typescript
it('session expires', async () => {
  const session = await createSession('test');

  // Wait actual 1.1 seconds!
  await new Promise(resolve => setTimeout(resolve, 1100));

  expect(session.expiresAt).toBeLessThan(Date.now());
});
```

**✅ ROBUST**
```typescript
it('session expires', async () => {
  jest.useFakeTimers();

  const session = await createSession('test');

  // Instantly advance time
  jest.advanceTimersByTime(1100);

  expect(session.expiresAt).toBeLessThan(Date.now());

  jest.useRealTimers();
});
```

---

### Example 4: Test Data

**❌ BRITTLE**
```typescript
it('creates session', async () => {
  // Hard-coded name - conflicts with parallel tests!
  await createSession('my-session');

  const session = await getSession('my-session');
  expect(session).toBeDefined();
});
```

**✅ ROBUST**
```typescript
it('creates session', async () => {
  const sessionName = uniqueSessionName('my-session');
  await createSession(sessionName);

  const session = await getSession(sessionName);
  expect(session).toBeDefined();
});
```

---

### Example 5: Loading States

**❌ BRITTLE**
```typescript
it('loads data', async () => {
  await page.click('[data-testid="load"]');
  await page.waitForTimeout(2000); // Hope data loads by then!

  expect(await page.locator('.data').count()).toBeGreaterThan(0);
});
```

**✅ ROBUST**
```typescript
it('loads data', async () => {
  const responsePromise = page.waitForResponse('/api/data');

  await page.click('[data-testid="load"]');
  await responsePromise;

  // Wait for UI to update
  await expect(page.locator('.data').first()).toBeVisible();
  expect(await page.locator('.data').count()).toBeGreaterThan(0);
});
```

---

### Example 6: Multi-Step Workflows

**❌ BRITTLE**
```typescript
it('completes workflow', async () => {
  await page.click('[data-testid="step1"]');
  await page.waitForTimeout(500);

  await page.click('[data-testid="step2"]');
  await page.waitForTimeout(500);

  await page.click('[data-testid="step3"]');
  await page.waitForTimeout(1000);

  expect(await page.textContent('.result')).toBe('Complete');
});
```

**✅ ROBUST**
```typescript
it('completes workflow', async () => {
  // Step 1
  await page.click('[data-testid="step1"]');
  await expect(page.locator('[data-testid="step2"]')).toBeEnabled();

  // Step 2
  await page.click('[data-testid="step2"]');
  await expect(page.locator('[data-testid="step3"]')).toBeEnabled();

  // Step 3
  await page.click('[data-testid="step3"]');
  await expect(page.locator('.result')).toHaveText('Complete');
});
```

---

## When to Use This Skill

- ✅ **Before writing any E2E tests** - Establish patterns upfront
- ✅ **Before writing integration tests** - Async behavior needs proper waits
- ✅ **When tests are flaky** - Random failures indicate timing issues
- ✅ **When tests are slow** - Look for `waitForTimeout` and `setTimeout`
- ✅ **When debugging test failures** - Check for brittle patterns
- ✅ **During code review** - Verify tests follow robust patterns

---

## Test Robustness Checklist

Use this checklist when writing or reviewing tests:

### Before Writing Tests
- [ ] Reviewed this skill document
- [ ] Imported helper utilities (`wait-helpers`, `time-helpers`, `seed-data`)
- [ ] Understand what conditions I'm waiting for (element, network, state)

### While Writing Tests
- [ ] **No `waitForTimeout` calls** - Use `waitForSelector`, `waitForResponse`, or assertions
- [ ] **No real time delays** - Use `jest.useFakeTimers()` and `advanceTimersByTime()`
- [ ] **All async operations have explicit waits** - Don't rely on arbitrary delays
- [ ] **Test data is unique** - Use `uniqueId()` or `seedSession()` helpers
- [ ] **Assertions use auto-wait** - Playwright's `expect()` automatically waits

### After Writing Tests
- [ ] **Run tests 10 times** - Verify no flakiness: `for i in {1..10}; do npm test; done`
- [ ] **Check test duration** - Should be fast (< 1s per test for unit, < 10s for E2E)
- [ ] **Verify in CI** - Tests pass consistently in CI environment
- [ ] **Review for clarity** - Explicit waits show what test expects

### Code Review Checklist
- [ ] **Zero `waitForTimeout` calls** - Flag for replacement
- [ ] **Zero `setTimeout` in tests** - Flag for fake timers
- [ ] **No hard-coded test data** - Should use helpers
- [ ] **Consistent uniqueness strategy** - All tests use same pattern
- [ ] **Clear wait conditions** - Can understand what test waits for

---

## Common Issues and Solutions

### Issue: "Element not found" Errors

**Problem**: Clicking element before it's ready

```typescript
// ❌ Flaky
await page.click('[data-testid="button"]'); // May not exist yet!

// ✅ Robust
await page.waitForSelector('[data-testid="button"]', { state: 'visible' });
await page.click('[data-testid="button"]');

// ✅ Even better (auto-waits)
await expect(page.locator('[data-testid="button"]')).toBeVisible();
await page.click('[data-testid="button"]');
```

### Issue: "Timeout" Errors

**Problem**: Waiting for something that takes variable time

```typescript
// ❌ Arbitrary timeout
await page.waitForTimeout(5000); // May be too short or too long

// ✅ Wait for specific condition
await page.waitForResponse(response =>
  response.url().includes('/api/data') && response.ok()
);
```

### Issue: Tests Pass Locally, Fail in CI

**Problem**: CI is slower, arbitrary timeouts are too short

```typescript
// ❌ Works locally (fast machine), fails CI (slow machine)
await page.waitForTimeout(1000);

// ✅ Works everywhere (waits for actual condition)
await expect(page.locator('.result')).toBeVisible();
```

### Issue: Random Test Failures

**Problem**: Race conditions from parallel tests

```typescript
// ❌ Tests conflict when run in parallel
it('test 1', async () => {
  await createSession('my-session'); // Conflicts with test 2!
});

it('test 2', async () => {
  await createSession('my-session'); // Same name!
});

// ✅ Each test uses unique data
it('test 1', async () => {
  await createSession(uniqueSessionName());
});

it('test 2', async () => {
  await createSession(uniqueSessionName());
});
```

### Issue: Slow Test Suite

**Problem**: Using real timers for time-based tests

```typescript
// ❌ Each test takes 1.1 seconds of real time
await new Promise(resolve => setTimeout(resolve, 1100));

// ✅ Each test takes ~0ms (instant)
jest.useFakeTimers();
jest.advanceTimersByTime(1100);
jest.useRealTimers();
```

---

## Performance Impact

### Current State (Brittle Tests)
- **33 instances of `waitForTimeout`** - Each adds 100-2000ms
- **6 instances of `setTimeout(1100)`** - Adds 6.6 seconds
- **Total overhead**: ~15-30 seconds per test run

### After Refactoring (Robust Tests)
- **0 arbitrary timeouts** - All waits are condition-based
- **0 real time delays** - All timers are mocked
- **Total overhead**: ~0-2 seconds (only real network/UI time)

**Expected speedup**: 10-15x faster test suite

---

## Migration Strategy

### Step 1: Audit Current Tests
```bash
# Find all waitForTimeout calls
grep -rn "waitForTimeout" tests/

# Find all setTimeout calls
grep -rn "setTimeout" tests/

# Find hard-coded test data
grep -rn "'session-" tests/
grep -rn "'feature-" tests/
```

### Step 2: Create Helper Files
1. Create `tests/helpers/wait-helpers.ts`
2. Create `tests/helpers/time-helpers.ts`
3. Create `tests/helpers/seed-data.ts`

### Step 3: Replace Patterns (One Test at a Time)
1. Replace `waitForTimeout` → `waitForSelector` or assertions
2. Replace `setTimeout` → `jest.useFakeTimers()` + `advanceTimersByTime()`
3. Replace hard-coded data → `uniqueSessionName()` or `seedSession()`

### Step 4: Verify Improvements
```bash
# Run tests 10 times to check for flakiness
for i in {1..10}; do npm test && echo "Run $i: PASS" || echo "Run $i: FAIL"; done

# Measure test duration
time npm test
```

### Step 5: Add to CI Checks
- Lint rule: Flag `waitForTimeout` in PR reviews
- Lint rule: Flag `setTimeout` in test files
- Pre-commit hook: Validate test patterns

---

## Reference

- **Playwright Waiting**: https://playwright.dev/docs/actionability
- **Playwright Assertions**: https://playwright.dev/docs/test-assertions
- **Jest Fake Timers**: https://jestjs.io/docs/timer-mocks
- **Testing Best Practices**: https://kentcdodds.com/blog/common-mistakes-with-react-testing-library

---

## Quick Reference

### Replace These Patterns

| ❌ Brittle Pattern | ✅ Robust Pattern |
|-------------------|------------------|
| `await page.waitForTimeout(1000)` | `await page.waitForSelector('.element')` |
| `await page.waitForTimeout(500)` | `await expect(page.locator('.element')).toBeVisible()` |
| `setTimeout(() => {}, 1100)` | `jest.advanceTimersByTime(1100)` |
| `await createSession('my-session')` | `await createSession(uniqueSessionName())` |
| `const id = 'test-123'` | `const id = uniqueId('test')` |
| `await page.click(); await delay(500)` | `await page.click(); await waitForLoadingComplete(page)` |

### Import These Helpers

```typescript
// Wait helpers
import {
  waitForInteractive,
  waitForLoadingComplete,
  waitForApiResponse,
  waitForPageLoad
} from '../helpers/wait-helpers';

// Time helpers
import {
  useFakeTimers,
  advanceTime,
  runAllTimers,
  useRealTimers,
  mockNow,
  restoreNow
} from '../helpers/time-helpers';

// Seed data helpers
import {
  uniqueId,
  uniqueSessionName,
  seedSession,
  seedFeature,
  seedProject
} from '../helpers/seed-data';
```

---

## Summary

**Golden Rules for Robust Tests:**

1. **Never use `waitForTimeout`** - Wait for specific conditions
2. **Never use real timers** - Mock time for instant tests
3. **Never hard-code test data** - Use unique, generated data
4. **Always wait for conditions** - Element visible, network complete, state changed
5. **Always use helpers** - DRY, consistent, maintainable

**Result**: Fast, reliable, maintainable test suite that never flakes.
