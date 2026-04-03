# Issue: Update UserRole type to include new "moderator" role

## Summary

We need to add a "moderator" role to the `UserRole` type used across the monorepo. The type is
currently defined in `packages/shared-types` and is consumed by three packages:

- `packages/api` — uses `UserRole` in middleware and database queries
- `packages/web` — uses `UserRole` for conditional rendering in the UI
- `packages/admin-dashboard` — uses `UserRole` for access control checks

## Requirements

- Add `moderator` to the `UserRole` union type in `packages/shared-types`
- Update all downstream consumers to handle the new role
- Moderators should have read access to all admin routes but cannot modify settings

## Context

This is a TypeScript monorepo managed with pnpm workspaces. `packages/shared-types` is a
dependency of all other packages.

## Acceptance Criteria

- [ ] `UserRole` type updated in shared-types
- [ ] All packages updated to handle moderator role
- [ ] TypeScript compilation passes across all packages
- [ ] Tests pass in all affected packages
