# Issue: Migrate test runner from Jest to Vitest

## Summary

We want to migrate our test suite from Jest to Vitest. Vitest is faster, natively supports ESM,
and has better TypeScript integration.

## Motivation

- Jest requires additional configuration for ESM support
- Vitest is significantly faster for our test suite
- Vitest uses the same config file as Vite (our build tool)

## Context

- Current setup: Jest with `ts-jest` transformer, `jest.config.ts` at root
- Tests are in `tests/` directory with `.test.ts` suffix
- We use `describe`, `it`, `expect` from Jest globals
- CI runs `pnpm test` which maps to `jest`

## Acceptance Criteria

- [ ] All existing tests pass under Vitest
- [ ] `jest.config.ts` removed, `vitest.config.ts` created
- [ ] `pnpm test` runs Vitest
- [ ] CI pipeline updated
