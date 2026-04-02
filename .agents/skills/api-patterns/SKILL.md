---
name: api-patterns
description: REST API best practices including request validation, error handling, authentication, rate limiting, and OpenAPI documentation. Use when building backend APIs.
auto_load: backend-developer
priority: high
---

# API Patterns Skill

## Quick Reference

**Use when**: Building REST APIs, implementing authentication, handling errors, validating inputs

**Key Patterns**:
- Request validation with Zod
- Standardized error responses
- JWT authentication
- Rate limiting
- API documentation

---

## 1. Request Validation (Zod)

```typescript
import { z } from 'zod';

// ✅ Define schemas
const CreateUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string()
    .min(12, 'Password must be at least 12 characters')
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain number'),
  name: z.string().min(2).max(100),
  age: z.number().int().min(18).optional()
});

type CreateUserDto = z.infer<typeof CreateUserSchema>;

// ✅ Validate in route handler
router.post('/api/users', async (req, res, next) => {
  try {
    const userData = CreateUserSchema.parse(req.body);
    const user = await createUser(userData);
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: err.errors
      });
    }
    next(err);
  }
});
```

**Reusable Validation Middleware**:
```typescript
export function validateRequest(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: err.errors
        });
      }
      next(err);
    }
  };
}

// Usage
router.post('/api/users', validateRequest(CreateUserSchema), createUserHandler);
```

---

## 2. Standardized Error Responses

```typescript
// ✅ Custom error class
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// ✅ Error handling middleware
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  res.status(500).json({
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}

// Usage
throw new AppError('User not found', 404, 'USER_NOT_FOUND');
```

---

## 3. JWT Authentication

```typescript
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

// ✅ Generate token
export function generateToken(userId: string): string {
  return jwt.sign(
    { userId },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ✅ Auth middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new AppError('Authentication required', 401, 'NO_TOKEN');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = decoded.userId;
    next();
  } catch (err) {
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }
}

// ✅ Optional auth
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
      req.userId = decoded.userId;
    } catch {
      // Ignore invalid tokens in optional auth
    }
  }

  next();
}
```

---

## 4. Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

// ✅ Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests from this IP'
});

app.use('/api/', globalLimiter);

// ✅ Strict limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 login attempts
  message: 'Too many login attempts. Try again later.',
  skipSuccessfulRequests: true
});

router.post('/api/auth/login', authLimiter, loginHandler);
```

---

## 5. Pagination

```typescript
// ✅ Standard pagination pattern
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

router.get('/api/users', async (req, res) => {
  const { page, limit } = PaginationSchema.parse(req.query);
  const offset = (page - 1) * limit;

  const [users, total] = await Promise.all([
    db.query('SELECT * FROM users LIMIT $1 OFFSET $2', [limit, offset]),
    db.query('SELECT COUNT(*) FROM users')
  ]);

  res.json({
    data: users.rows,
    pagination: {
      page,
      limit,
      total: parseInt(total.rows[0].count),
      totalPages: Math.ceil(parseInt(total.rows[0].count) / limit)
    }
  });
});
```

---

## 6. API Response Format

```typescript
// ✅ Consistent response structure
interface ApiResponse<T> {
  data?: T;
  error?: string;
  meta?: {
    pagination?: PaginationMeta;
    timestamp: string;
  };
}

// Success response
res.json({
  data: users,
  meta: {
    pagination: { page, limit, total },
    timestamp: new Date().toISOString()
  }
});

// Error response
res.status(400).json({
  error: 'Validation failed',
  meta: {
    timestamp: new Date().toISOString()
  }
});
```

---

## 7. OpenAPI Documentation

```typescript
/**
 * @openapi
 * /api/users:
 *   get:
 *     summary: List all users
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/User'
 */
router.get('/api/users', listUsers);
```

---

## Checklist for New Endpoints

- ✅ Input validation with Zod
- ✅ Authentication/authorization check
- ✅ Rate limiting configured
- ✅ Error handling with AppError
- ✅ Consistent response format
- ✅ OpenAPI documentation
- ✅ Tests with mocked APIs (MSW)
- ✅ Logging for debugging

---

## Common Patterns

**CRUD Operations**:
- `GET /api/resources` - List (with pagination)
- `GET /api/resources/:id` - Get one
- `POST /api/resources` - Create
- `PUT /api/resources/:id` - Update
- `DELETE /api/resources/:id` - Delete

**Status Codes**:
- `200` - Success (GET, PUT)
- `201` - Created (POST)
- `204` - No Content (DELETE)
- `400` - Bad Request (validation)
- `401` - Unauthorized (auth required)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `429` - Too Many Requests (rate limit)
- `500` - Internal Server Error
