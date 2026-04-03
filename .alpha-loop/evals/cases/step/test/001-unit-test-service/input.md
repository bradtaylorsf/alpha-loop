# Task: Write unit tests for UserService

Write Jest unit tests for the following `UserService` class. Cover the happy path, error cases,
and edge cases for all three methods.

## Source Code

```typescript
// src/services/user.service.ts
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface CreateUserInput {
  name: string;
  email: string;
}

export class UserService {
  private users: Map<string, User> = new Map();

  async create(input: CreateUserInput): Promise<User> {
    const existing = [...this.users.values()].find(u => u.email === input.email);
    if (existing) {
      throw new Error(`User with email ${input.email} already exists`);
    }
    if (!input.name.trim()) {
      throw new Error('Name cannot be empty');
    }
    const user: User = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      email: input.email.toLowerCase(),
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async get(id: string): Promise<User> {
    const user = this.users.get(id);
    if (!user) {
      throw new Error(`User not found: ${id}`);
    }
    return user;
  }

  async update(id: string, data: Partial<CreateUserInput>): Promise<User> {
    const user = await this.get(id);
    const updated = { ...user, ...data };
    this.users.set(id, updated);
    return updated;
  }
}
```

## Requirements

- Use Jest (`describe`, `it`, `expect`)
- Reset service state between tests with `beforeEach`
- Cover create: success, duplicate email, empty name
- Cover get: success, not found
- Cover update: success, not found
- Add at least one edge case (e.g., name with only whitespace, email normalization)
