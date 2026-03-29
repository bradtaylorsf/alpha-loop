---
name: api-contracts
description: Shared type contracts between backend and frontend to prevent API response mismatches. Essential for all full-stack features.
auto_load: backend-developer, frontend-developer, integration-specialist
priority: critical
---

# API Contracts Skill

## Quick Reference

**Use when**: Implementing ANY feature that spans backend and frontend

**Purpose**: Prevent API response mismatches by defining shared TypeScript interfaces

**Key Pattern**: Single source of truth for API response types used by both backend and frontend

**Critical**: This skill prevents the "Test-Reality Gap" where unit tests pass but production fails due to API contract mismatches.

---

## The Problem This Solves

### Before Shared Contracts (Causes Production Failures)

**Backend** (`src/server/routes/dependencies.ts`):
```typescript
// Backend developer's assumption
router.get('/dependency-graph', (req, res) => {
  const nodes = {}; // Returns Object
  features.forEach(f => {
    nodes[f.id] = { id: f.id, dependsOn: f.depends_on_features };
  });
  res.json({ nodes });
});
```

**Frontend** (`src/client/components/DependencyGraph.tsx`):
```typescript
// Frontend developer's assumption
const graph = await response.json();
graph.nodes.forEach(node => {  // ❌ CRASH: nodes is Object, not Array
  renderNode(node.name);        // ❌ CRASH: name field doesn't exist
});
```

**Result**: All unit tests pass (mocked data is "perfect"), but production fails with runtime errors.

### After Shared Contracts (Prevents Failures)

**Shared Contract** (`src/shared/types/api-contracts.ts`):
```typescript
export interface DependencyGraphResponse {
  nodes: DependencyNode[];  // ✅ Both backend and frontend agree: Array
}

export interface DependencyNode {
  id: number;
  name: string;              // ✅ Frontend knows this field exists
  dependsOn: number[];
}
```

**Backend** (TypeScript enforces compliance):
```typescript
import { DependencyGraphResponse } from '../shared/types/api-contracts';

router.get('/dependency-graph', (req, res) => {
  const response: DependencyGraphResponse = {
    nodes: features.map(f => ({
      id: f.id,
      name: f.description,      // ✅ Must include name field
      dependsOn: f.depends_on_features || []
    }))  // ✅ Must be Array
  };
  res.json(response);  // ✅ TypeScript validates structure
});
```

**Frontend** (TypeScript knows exact structure):
```typescript
import { DependencyGraphResponse } from '../../shared/types/api-contracts';

const graph: DependencyGraphResponse = await response.json();
graph.nodes.forEach(node => {  // ✅ TypeScript knows nodes is Array
  renderNode(node.name);        // ✅ TypeScript knows name exists
});
```

---

## Pattern: Creating Shared Contracts

### Step 1: Create Shared Types Directory

```bash
# Create directory structure
mkdir -p src/shared/types

# Create api-contracts.ts
touch src/shared/types/api-contracts.ts
```

### Step 2: Define Complete API Response Interface

```typescript
// src/shared/types/api-contracts.ts

/**
 * GET /api/projects/:id/features/dependency-graph
 *
 * Returns dependency graph data for visualization.
 *
 * Used by:
 * - Backend: src/server/routes/dependencies.ts
 * - Frontend: src/client/components/DependencyGraph.tsx
 *
 * @example
 * {
 *   nodes: [
 *     { id: 1, name: "Authentication", status: "completed", dependsOn: [], blocks: [2] },
 *     { id: 2, name: "User Profile", status: "pending", dependsOn: [1], blocks: [] }
 *   ],
 *   edges: [
 *     { from: 2, to: 1, type: "dependency" }
 *   ],
 *   hasCircularDependencies: false,
 *   circularDependencies: []
 * }
 */
export interface DependencyGraphResponse {
  /** List of all features as graph nodes */
  nodes: DependencyNode[];

  /** List of edges connecting nodes */
  edges: DependencyEdge[];

  /** Map of feature ID to count of unmet dependencies */
  unmetDependencies: Record<number, number>;

  /** Whether circular dependencies exist */
  hasCircularDependencies: boolean;

  /** List of detected circular dependency cycles */
  circularDependencies: CircularDependency[];
}

/**
 * Single feature node in dependency graph
 */
export interface DependencyNode {
  /** Feature ID */
  id: number;

  /** Feature name (displayed in graph node) */
  name: string;

  /** Full feature description (shown in tooltip) */
  description: string;

  /** Current implementation status */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';

  /** Category for color coding */
  category: string;

  /** List of feature IDs this feature depends on */
  dependsOn: number[];

  /** List of feature IDs this feature blocks */
  blocks: number[];
}

/**
 * Edge connecting two nodes in the graph
 */
export interface DependencyEdge {
  /** Source node ID */
  from: number;

  /** Target node ID */
  to: number;

  /** Edge type for styling */
  type: 'dependency' | 'blocks';
}

/**
 * Circular dependency detection result
 */
export interface CircularDependency {
  /** List of feature IDs forming the cycle */
  cycle: number[];

  /** Human-readable description */
  description: string;
}
```

### Step 3: Document Example Responses

Always include `@example` JSDoc tag with realistic response data:

```typescript
/**
 * User authentication response
 *
 * @example
 * {
 *   user: {
 *     id: 123,
 *     email: "user@example.com",
 *     name: "John Doe",
 *     role: "admin"
 *   },
 *   token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
 *   expiresAt: 1640995200000
 * }
 */
export interface AuthResponse {
  user: User;
  token: string;
  expiresAt: number;
}
```

### Step 4: Mark Required vs Optional Fields

```typescript
export interface UpdateUserRequest {
  /** User's email (REQUIRED) */
  email: string;

  /** User's display name (REQUIRED) */
  name: string;

  /** User's age (OPTIONAL) */
  age?: number;

  /** User's bio (OPTIONAL - can be empty string) */
  bio?: string;
}
```

---

## Pattern: Backend Usage

### Import and Use Shared Contract

```typescript
// src/server/routes/dependencies.ts

import { Router } from 'express';
import {
  DependencyGraphResponse,
  DependencyNode,
  DependencyEdge
} from '../shared/types/api-contracts';
import { getDependencyGraph } from '../dal/dependency-resolver';

const router = Router();

router.get('/api/projects/:id/features/dependency-graph', (req, res) => {
  const projectId = parseInt(req.params.id, 10);

  // Get data from DAL
  const { nodes, edges, cycles } = getDependencyGraph(projectId);

  // Build response matching shared contract
  const response: DependencyGraphResponse = {
    nodes: nodes.map((node): DependencyNode => ({
      id: node.id,
      name: node.name || `Feature ${node.id}`,
      description: node.description || '',
      status: node.status,
      category: node.category || 'general',
      dependsOn: node.dependsOn || [],
      blocks: node.blocks || []
    })),
    edges: edges.map((edge): DependencyEdge => ({
      from: edge.from,
      to: edge.to,
      type: edge.type
    })),
    unmetDependencies: {},
    hasCircularDependencies: cycles.length > 0,
    circularDependencies: cycles
  };

  // TypeScript validates response matches contract
  res.json(response);
});

export default router;
```

### Ensure ALL Required Fields Present

```typescript
// ❌ WRONG - Missing required fields
const response: DependencyGraphResponse = {
  nodes: nodes.map(n => ({ id: n.id }))  // TypeScript error: missing name, description, status, etc.
};

// ✅ CORRECT - All required fields provided
const response: DependencyGraphResponse = {
  nodes: nodes.map(n => ({
    id: n.id,
    name: n.description,                    // Map from database field
    description: n.full_description || '',  // Provide default if missing
    status: n.passes ? 'completed' : 'pending',
    category: n.category || 'general',
    dependsOn: n.depends_on_features || [], // Provide empty array if null
    blocks: n.blocks_features || []
  }))
};
```

---

## Pattern: Frontend Usage

### Import and Use Shared Contract

```typescript
// src/client/components/DependencyGraph.tsx

import React, { useState, useEffect } from 'react';
import {
  DependencyGraphResponse,
  DependencyNode
} from '../../shared/types/api-contracts';

export function DependencyGraph({ projectId }: { projectId: number }) {
  const [graph, setGraph] = useState<DependencyGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchGraph() {
      try {
        const response = await fetch(`/api/projects/${projectId}/features/dependency-graph`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // TypeScript knows exact shape of response
        const data: DependencyGraphResponse = await response.json();
        setGraph(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    }

    fetchGraph();
  }, [projectId]);

  if (error) {
    return <div className="error">Error loading graph: {error}</div>;
  }

  if (!graph) {
    return <div>Loading...</div>;
  }

  return (
    <div className="dependency-graph">
      {/* TypeScript knows nodes is Array with specific fields */}
      {graph.nodes.map((node: DependencyNode) => (
        <div key={node.id} className="graph-node">
          <h3>{node.name}</h3>
          <p>{node.description}</p>
          <span className={`status-${node.status}`}>{node.status}</span>
        </div>
      ))}
    </div>
  );
}
```

### TypeScript Catches Errors at Compile Time

```typescript
// ❌ TypeScript error: nodes might be undefined
graph.nodes.map(node => ...);

// ✅ CORRECT: Check for null
{graph?.nodes.map(node => ...)}

// ❌ TypeScript error: field doesn't exist on DependencyNode
node.title

// ✅ CORRECT: Use correct field from contract
node.name

// ❌ TypeScript error: wrong status value
node.status === 'done'

// ✅ CORRECT: Use value from contract's union type
node.status === 'completed'
```

---

## Pattern: Updating Contracts

When API changes, update contract FIRST, then let TypeScript guide you:

### 1. Update Shared Contract

```typescript
// src/shared/types/api-contracts.ts

export interface DependencyNode {
  id: number;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  category: string;
  dependsOn: number[];
  blocks: number[];
  priority: 'low' | 'medium' | 'high';  // ✅ NEW FIELD ADDED
}
```

### 2. TypeScript Shows Compilation Errors

```bash
$ pnpm build

src/server/routes/dependencies.ts:45:7 - error TS2322:
  Type '{ id: number; name: string; ... }' is not assignable to type 'DependencyNode'.
  Property 'priority' is missing in type '...' but required in type 'DependencyNode'.

src/client/components/DependencyGraph.tsx:67:23 - error TS2339:
  Property 'priority' does not exist on type '{ id: number; name: string; ... }'.
```

### 3. Fix Backend First

```typescript
// src/server/routes/dependencies.ts

nodes: nodes.map(n => ({
  // ... existing fields
  priority: n.priority || 'medium'  // ✅ Add new field
}))
```

### 4. Fix Frontend Second

```typescript
// src/client/components/DependencyGraph.tsx

<div className="graph-node">
  <h3>{node.name}</h3>
  <span className={`priority-${node.priority}`}>{node.priority}</span>  {/* ✅ Use new field */}
</div>
```

### 5. Compilation Succeeds

All TypeScript errors resolved. Contract updated everywhere.

---

## Common Contracts to Create

### 1. List/Collection Responses

```typescript
/**
 * GET /api/projects/:id/features
 */
export interface FeaturesListResponse {
  features: Feature[];
  total: number;
  page: number;
  pageSize: number;
}
```

### 2. Single Resource Responses

```typescript
/**
 * GET /api/projects/:id
 */
export interface ProjectResponse {
  project: Project;
}
```

### 3. Create/Update Requests

```typescript
/**
 * POST /api/projects
 */
export interface CreateProjectRequest {
  name: string;
  description?: string;
  techStack: {
    frontend: string;
    backend: string;
    database: string;
  };
}

export interface CreateProjectResponse {
  project: Project;
  message: string;
}
```

### 4. Error Responses

```typescript
/**
 * Standard error response (4xx, 5xx)
 */
export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: Record<string, string[]>;  // Validation errors
}
```

---

## Validation Pattern

Always validate API responses match contracts:

```typescript
// tests/api/contracts/dependency-graph.contract.test.ts

import { DependencyGraphResponse, DependencyNode } from '../../../src/shared/types/api-contracts';

describe('Dependency Graph API Contract', () => {
  it('returns response matching DependencyGraphResponse interface', async () => {
    const response = await fetch('http://localhost:4243/api/projects/1/features/dependency-graph');
    expect(response.ok).toBe(true);

    const data = await response.json();

    // Validate top-level structure
    expect(data).toHaveProperty('nodes');
    expect(data).toHaveProperty('edges');
    expect(data).toHaveProperty('hasCircularDependencies');

    // Validate types
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(typeof data.hasCircularDependencies).toBe('boolean');

    // Validate node structure (if any nodes exist)
    if (data.nodes.length > 0) {
      const node = data.nodes[0];
      expect(typeof node.id).toBe('number');
      expect(typeof node.name).toBe('string');
      expect(typeof node.description).toBe('string');
      expect(['pending', 'in_progress', 'completed', 'blocked']).toContain(node.status);
      expect(Array.isArray(node.dependsOn)).toBe(true);
      expect(Array.isArray(node.blocks)).toBe(true);
    }
  });
});
```

---

## Checklist for Every Full-Stack Feature

Before implementation starts:
- [ ] Shared contract created in `src/shared/types/api-contracts.ts`
- [ ] All request/response interfaces defined
- [ ] Example responses documented with `@example` JSDoc
- [ ] Required vs optional fields clearly marked

During backend implementation:
- [ ] Backend imports shared contract types
- [ ] Backend response typed as contract interface
- [ ] All required fields provided (no TypeScript errors)
- [ ] Contract validation test written

During frontend implementation:
- [ ] Frontend imports shared contract types
- [ ] API response typed as contract interface
- [ ] TypeScript shows autocomplete for all fields
- [ ] No `any` types used

Before marking complete:
- [ ] TypeScript compiles without errors
- [ ] Contract tests pass
- [ ] Integration tests pass
- [ ] Manual browser verification shows no errors

---

## Common Mistakes to Avoid

### Mistake 1: Forgetting to Create Contract

```typescript
// ❌ WRONG - No shared contract
// backend.ts
res.json({ nodes: Object.values(graph) });

// frontend.ts
const data: any = await response.json();  // No type safety
```

**Fix**: Create shared contract first, before any implementation.

### Mistake 2: Backend and Frontend Use Different Interfaces

```typescript
// ❌ WRONG - Duplicated interfaces
// backend/types.ts
interface GraphResponse { nodes: Node[] }

// frontend/types.ts
interface GraphData { items: Node[] }  // Different name!
```

**Fix**: Use SINGLE shared interface imported by both.

### Mistake 3: Using `any` Instead of Contract

```typescript
// ❌ WRONG - Loses type safety
const data: any = await response.json();

// ✅ CORRECT - Use contract type
const data: DependencyGraphResponse = await response.json();
```

### Mistake 4: Contract Doesn't Match Reality

```typescript
// ❌ WRONG - Contract says Array, backend returns Object
export interface Response {
  nodes: Node[];  // Contract says Array
}

// backend.ts
res.json({ nodes: { "1": node1, "2": node2 } });  // Returns Object!
```

**Fix**: Contract tests will catch this mismatch.

---

## Summary

**Core Principle**: API contracts are the single source of truth for communication between backend and frontend.

**When to Create**: Before starting ANY full-stack feature implementation.

**Who Uses**:
- Backend developers: Type their responses
- Frontend developers: Type their API data
- Integration specialists: Validate responses match
- QA specialists: Write contract tests

**Benefits**:
- TypeScript catches mismatches at compile time
- Eliminates runtime errors from unexpected API responses
- Provides autocomplete in both backend and frontend
- Self-documenting with JSDoc examples
- Prevents the Test-Reality Gap

**Remember**: Unit tests passing is NOT enough. Shared contracts + contract tests + integration tests = Production confidence.
