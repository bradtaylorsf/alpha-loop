# Issue #67: Add rate limiting to API routes

## Summary

The public API has no rate limiting. A single client can hammer endpoints and degrade service for
everyone. Add configurable rate limiting middleware.

## Requirements

- Use `express-rate-limit` (already in package.json)
- Default limits: 100 requests per 15-minute window per IP
- Auth endpoints (`/auth/*`) should have stricter limits: 10 requests per 15 minutes
- Return HTTP 429 with a JSON error body when the limit is exceeded
- Include standard `RateLimit-*` headers in responses
- Limits should be configurable via environment variables

## Current App Structure

```typescript
// src/app.ts
import express from 'express';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/api', apiRouter);

export { app };
```

## Expected 429 Response

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later"
  }
}
```

## Acceptance Criteria

- [ ] General API routes limited to 100 req / 15 min
- [ ] Auth routes limited to 10 req / 15 min
- [ ] Exceeding limit returns HTTP 429 with JSON body
- [ ] Limits configurable via env vars
- [ ] Test verifies 429 is returned after limit is exceeded
