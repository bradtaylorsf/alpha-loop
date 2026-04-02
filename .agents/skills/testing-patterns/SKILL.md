---
name: testing-patterns
description: TDD patterns, Jest testing conventions, and test quality standards. Use when writing any tests.
auto_load: true
priority: high
---

# Testing Patterns Skill

## Trigger
When writing tests or implementing features that need tests.

## TDD Flow

1. **Red**: Write a failing test first
2. **Green**: Write minimal code to pass
3. **Refactor**: Clean up while tests stay green

## Test Structure

```typescript
describe('ModuleName', () => {
  describe('functionName', () => {
    it('should do expected behavior when given input', () => {
      // Arrange
      const input = createTestInput();

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toEqual(expectedOutput);
    });

    it('should throw when given invalid input', () => {
      expect(() => functionName(null)).toThrow();
    });
  });
});
```

## Rules

### Naming
- Describe behavior, not implementation
- Good: `should return 404 when user not found`
- Bad: `test getUserById`

### Isolation
- Each test is independent (no shared mutable state)
- Use `beforeEach` for setup, not `beforeAll` for mutable state
- Clean up after tests (close connections, clear timers)

### Mocking
- Mock external dependencies (APIs, databases, file system)
- Don't mock the thing you're testing
- Use `jest.mock()` at module level, `jest.spyOn()` for specific methods
- Reset mocks between tests: `jest.restoreAllMocks()` in `afterEach`

### What to Test
- Happy path (expected input -> expected output)
- Error cases (invalid input, missing data, network failures)
- Edge cases (empty arrays, null values, boundary conditions)
- Integration points (API endpoints with supertest)

### What NOT to Test
- Third-party library internals
- TypeScript type checking (the compiler does this)
- Simple getters/setters with no logic

### Anti-Patterns to Avoid
- No `waitForTimeout()` or `sleep()` in tests
- No hardcoded test IDs that depend on database state
- No tests that depend on execution order
- No `any` type assertions to make tests pass
