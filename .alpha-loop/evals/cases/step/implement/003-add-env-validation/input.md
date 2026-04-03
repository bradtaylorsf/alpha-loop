# Issue #41: Validate required environment variables on startup

## Summary

The app silently starts with missing env vars and crashes at runtime when it tries to use them.
This makes debugging very hard in staging. We need fast-fail validation at startup.

## Required Variables

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Secret for signing JWTs (must be at least 32 chars)
- `PORT` — Port to listen on (defaults to 3000 if missing is acceptable)

## Current Behavior

App starts successfully even when `DATABASE_URL` is not set. First request that hits the DB causes
an opaque connection error.

## Expected Behavior

On startup, if any required variable is missing, the process should print a clear error and exit:

```
Error: Missing required environment variable: DATABASE_URL
```

## Existing Entry Point

```typescript
// src/index.ts
import { app } from './app.js';

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

## Acceptance Criteria

- [ ] Validation runs before server starts
- [ ] Missing variable name is included in the error message
- [ ] Process exits with non-zero code on missing required var
- [ ] `PORT` is optional with a default
