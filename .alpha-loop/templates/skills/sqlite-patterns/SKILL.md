---
name: sqlite-patterns
description: SQLite database patterns using better-sqlite3. Synchronous API, file-based storage, great for single-user apps and development.
---

# SQLite Patterns Skill

Patterns for SQLite database operations using better-sqlite3.

## When to Use SQLite

- Single-user applications
- Development/prototyping
- File-based storage needs
- Simple applications without concurrency
- Embedded databases

## Setup

```typescript
import Database from 'better-sqlite3';

// Production
const db = new Database('./data/app.db');

// Testing (in-memory)
const testDb = new Database(':memory:');

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
```

## Basic Patterns

### Query Single Row

```typescript
function getUserById(id: number): User | null {
  const result = db.prepare(`
    SELECT id, email, name, created_at as createdAt
    FROM users
    WHERE id = ?
  `).get(id);

  return result ?? null; // better-sqlite3 returns undefined, not null
}
```

### Query Multiple Rows

```typescript
function getAllUsers(): User[] {
  return db.prepare(`
    SELECT id, email, name, created_at as createdAt
    FROM users
    ORDER BY created_at DESC
  `).all() as User[];
}
```

### Insert and Get ID

```typescript
function createUser(data: CreateUserDto): User {
  const stmt = db.prepare(`
    INSERT INTO users (email, password_hash, name)
    VALUES (?, ?, ?)
  `);

  const info = stmt.run(data.email, passwordHash, data.name);
  const id = info.lastInsertRowid;

  return getUserById(Number(id))!;
}
```

### Update

```typescript
function updateUser(id: number, updates: UpdateUserDto): User | null {
  const stmt = db.prepare(`
    UPDATE users
    SET email = COALESCE(?, email),
        name = COALESCE(?, name),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const info = stmt.run(updates.email, updates.name, id);

  if (info.changes === 0) return null;
  return getUserById(id);
}
```

### Delete

```typescript
function deleteUser(id: number): boolean {
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return info.changes > 0;
}
```

## Transactions

```typescript
function transferFunds(fromId: number, toId: number, amount: number): void {
  const transfer = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?')
      .run(amount, fromId);

    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?')
      .run(amount, toId);
  });

  transfer(); // Automatically rolls back on error
}
```

## JSON Fields

```typescript
// Store JSON
function saveSettings(userId: number, settings: Settings): void {
  db.prepare(`
    UPDATE users SET settings = ? WHERE id = ?
  `).run(JSON.stringify(settings), userId);
}

// Parse JSON
function getSettings(userId: number): Settings {
  const result = db.prepare(`
    SELECT settings FROM users WHERE id = ?
  `).get(userId) as { settings: string } | undefined;

  return result ? JSON.parse(result.settings) : {};
}

// Helper for safe JSON parsing
function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
```

## Migrations

```sql
-- migrations/001_create_users.sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  settings TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
```

```typescript
// Run migrations
function runMigrations(db: Database.Database): void {
  const migrations = fs.readdirSync('./migrations')
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of migrations) {
    const sql = fs.readFileSync(`./migrations/${file}`, 'utf-8');
    db.exec(sql);
  }
}
```

## Error Handling

```typescript
function createUser(data: CreateUserDto): User {
  try {
    // ... insert logic
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) {
      const sqliteError = error as { code: string };
      if (sqliteError.code === 'SQLITE_CONSTRAINT') {
        throw new AppError('Email already exists', 400);
      }
    }
    throw error;
  }
}
```

## Timestamps

```typescript
// SQLite datetime format
const now = new Date().toISOString(); // '2024-01-15T10:30:00.000Z'

// Or use SQLite's built-in
db.prepare(`
  INSERT INTO logs (message, created_at)
  VALUES (?, datetime('now'))
`).run(message);
```

## Best Practices

1. **Use prepared statements** - Prevents SQL injection
2. **Use transactions** - For multiple related operations
3. **Enable WAL mode** - Better concurrent read performance
4. **Use in-memory for tests** - Fast, isolated testing
5. **Handle undefined** - better-sqlite3 returns undefined, not null
6. **Index foreign keys** - Improve JOIN performance
7. **Use COALESCE for updates** - Partial updates without overwriting

## Common Gotchas

- Returns `undefined` not `null` for missing rows
- `lastInsertRowid` is a BigInt (convert with Number())
- JSON must be stringified before storage
- Datetime stored as TEXT (ISO format recommended)
- No native boolean type (use INTEGER 0/1)
