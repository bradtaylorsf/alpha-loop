# Issue #12: Add GET /health endpoint

## Summary

The service has no health check endpoint. Kubernetes liveness probes are failing because there is
no route to hit. We need a simple health check route.

## Requirements

- Add `GET /health` route to the Express app
- Response must be JSON: `{ "status": "ok", "timestamp": "<ISO string>" }`
- Return HTTP 200
- Add a test for the endpoint

## Existing Code

```typescript
// src/app.ts
import express from 'express';
import { userRouter } from './routes/users.js';

const app = express();
app.use(express.json());
app.use('/users', userRouter);

export { app };
```

## Acceptance Criteria

- [ ] `GET /health` returns 200 with JSON body
- [ ] Body includes `status` and `timestamp` fields
- [ ] Test covers the happy path
