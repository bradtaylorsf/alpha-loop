/**
 * Complete REST API Example with Best Practices
 * Demonstrates: validation, auth, rate limiting, error handling
 */

import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware
app.use(express.json());
app.use(helmet());

// Custom error class
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

// Validation schemas
const CreateUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string()
    .min(12, 'Password must be at least 12 characters')
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain number'),
  name: z.string().min(2).max(100)
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

// Type inference
type CreateUserDto = z.infer<typeof CreateUserSchema>;
type LoginDto = z.infer<typeof LoginSchema>;
type PaginationDto = z.infer<typeof PaginationSchema>;

// Validation middleware
function validateRequest(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const target = req.method === 'GET' ? req.query : req.body;
      req.body = schema.parse(target);
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

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    throw new AppError('Authentication required', 401, 'NO_TOKEN');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    (req as any).userId = decoded.userId;
    next();
  } catch (err) {
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }
}

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests from this IP'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 login attempts
  message: 'Too many login attempts. Try again later.',
  skipSuccessfulRequests: true
});

app.use('/api/', globalLimiter);

// Mock database
const users: any[] = [];

// Routes

// POST /api/auth/register
app.post(
  '/api/auth/register',
  validateRequest(CreateUserSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, name } = req.body as CreateUserDto;

      // Check if user exists
      if (users.find(u => u.email === email)) {
        throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create user
      const user = {
        id: String(users.length + 1),
        email,
        name,
        passwordHash,
        createdAt: new Date().toISOString()
      };

      users.push(user);

      // Generate token
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

      res.status(201).json({
        data: {
          user: { id: user.id, email: user.email, name: user.name },
          token
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/login
app.post(
  '/api/auth/login',
  authLimiter,
  validateRequest(LoginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as LoginDto;

      // Find user
      const user = users.find(u => u.email === email);
      if (!user) {
        throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
      }

      // Verify password
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
      }

      // Generate token
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

      res.json({
        data: {
          user: { id: user.id, email: user.email, name: user.name },
          token
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/users (paginated)
app.get(
  '/api/users',
  requireAuth,
  validateRequest(PaginationSchema),
  async (req: Request, res: Response) => {
    const { page, limit } = req.body as PaginationDto;
    const offset = (page - 1) * limit;

    const paginatedUsers = users
      .slice(offset, offset + limit)
      .map(({ passwordHash, ...user }) => user);

    res.json({
      data: paginatedUsers,
      pagination: {
        page,
        limit,
        total: users.length,
        totalPages: Math.ceil(users.length / limit)
      },
      meta: {
        timestamp: new Date().toISOString()
      }
    });
  }
);

// GET /api/users/:id
app.get(
  '/api/users/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = users.find(u => u.id === req.params.id);

      if (!user) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      const { passwordHash, ...userData } = user;
      res.json({ data: userData });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/users/:id
app.delete(
  '/api/users/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;
      const targetId = req.params.id;

      // Check authorization (can only delete own account unless admin)
      if (userId !== targetId) {
        throw new AppError('Forbidden', 403, 'FORBIDDEN');
      }

      const index = users.findIndex(u => u.id === targetId);
      if (index === -1) {
        throw new AppError('User not found', 404, 'USER_NOT_FOUND');
      }

      users.splice(index, 1);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
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
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
