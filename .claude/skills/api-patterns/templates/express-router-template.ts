/**
 * Express Router Template
 * Use this template for creating new resource routers
 */

import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middleware/validation';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../utils/errors';

const router = Router();

// ============================================================================
// Validation Schemas
// ============================================================================

const CreateSchema = z.object({
  // Define your fields here
  name: z.string().min(1).max(255),
  description: z.string().optional()
});

const UpdateSchema = CreateSchema.partial();

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// Type inference
type CreateDto = z.infer<typeof CreateSchema>;
type UpdateDto = z.infer<typeof UpdateSchema>;
type QueryDto = z.infer<typeof QuerySchema>;

// ============================================================================
// Routes
// ============================================================================

/**
 * @openapi
 * /api/resources:
 *   get:
 *     summary: List all resources
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: List of resources
 */
router.get(
  '/',
  requireAuth,
  validateRequest(QuerySchema),
  async (req, res, next) => {
    try {
      const query = req.body as QueryDto;
      const { page, limit, sortBy, sortOrder } = query;
      const offset = (page - 1) * limit;

      // TODO: Replace with actual database query
      const resources = [];
      const total = 0;

      res.json({
        data: resources,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/resources/{id}:
 *   get:
 *     summary: Get a single resource
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Resource found
 *       404:
 *         description: Resource not found
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    // TODO: Replace with actual database query
    const resource = null;

    if (!resource) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }

    res.json({ data: resource });
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/resources:
 *   post:
 *     summary: Create a new resource
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Resource created
 */
router.post(
  '/',
  requireAuth,
  validateRequest(CreateSchema),
  async (req, res, next) => {
    try {
      const data = req.body as CreateDto;
      const userId = (req as any).userId;

      // TODO: Replace with actual database insert
      const resource = {
        id: 'generated-id',
        ...data,
        userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      res.status(201).json({ data: resource });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/resources/{id}:
 *   put:
 *     summary: Update a resource
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Resource updated
 *       404:
 *         description: Resource not found
 */
router.put(
  '/:id',
  requireAuth,
  validateRequest(UpdateSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const data = req.body as UpdateDto;
      const userId = (req as any).userId;

      // TODO: Replace with actual database query
      const resource = null;

      if (!resource) {
        throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
      }

      // Check authorization
      if ((resource as any).userId !== userId) {
        throw new AppError('Forbidden', 403, 'FORBIDDEN');
      }

      // TODO: Replace with actual database update
      const updated = {
        ...resource,
        ...data,
        updatedAt: new Date().toISOString()
      };

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/resources/{id}:
 *   delete:
 *     summary: Delete a resource
 *     tags: [Resources]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Resource deleted
 *       404:
 *         description: Resource not found
 */
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;

    // TODO: Replace with actual database query
    const resource = null;

    if (!resource) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }

    // Check authorization
    if ((resource as any).userId !== userId) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    // TODO: Replace with actual database delete

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
