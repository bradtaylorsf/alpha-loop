# Issue: Add last_login column to users table

## Summary

We need to track when users last logged into the application. Add a `last_login` column to the
`users` table that gets updated on every successful authentication.

## Requirements

- Column name: `last_login`
- Type: timestamp with timezone
- Nullable: yes (null means the user has never logged in)
- Update on every successful login event

## Context

- We use Prisma as our ORM
- The database is PostgreSQL
- Migrations are managed via `prisma migrate`
- Tests run against a separate test database configured in `.env.test`

## Acceptance Criteria

- [ ] Migration created and applied
- [ ] `last_login` field populated on successful login
- [ ] Existing users have `null` value (not broken)
- [ ] Tests pass
