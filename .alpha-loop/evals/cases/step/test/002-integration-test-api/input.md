# Task: Write integration tests for POST /users

Write supertest integration tests for the Express `POST /users` endpoint below. Tests must use
proper setup and teardown to avoid leaving open connections.

## Source Code

```typescript
// src/app.ts
import express from 'express';
import { usersRouter } from './routes/users.js';

export const app = express();
app.use(express.json());
app.use('/users', usersRouter);
```

```typescript
// src/routes/users.ts
import { Router } from 'express';
import { db } from '../lib/db.js';

export const usersRouter = Router();

usersRouter.post('/', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const user = await db.user.create({ data: { name, email } });
  return res.status(201).json({ data: user });
});
```

## Requirements

- Use `supertest` and import the `app` directly (do not start a real server)
- Test cases:
  1. Valid request returns 201 with user in `data`
  2. Missing `name` returns 400
  3. Missing `email` returns 400
  4. Duplicate email returns 409
- Mock the `db` module so tests do not need a real database
- Use `afterAll` to ensure no open handles remain
