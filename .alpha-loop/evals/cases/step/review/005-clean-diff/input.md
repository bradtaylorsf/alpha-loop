```diff
diff --git a/src/services/user.service.ts b/src/services/user.service.ts
index 2a3c1d4..8b5e6f7 100644
--- a/src/services/user.service.ts
+++ b/src/services/user.service.ts
@@ -1,6 +1,7 @@
 import { prisma } from '../lib/prisma.js';
 import { hashPassword } from '../lib/crypto.js';
 import { UserNotFoundError, DuplicateEmailError } from '../errors.js';
+import { logger } from '../lib/logger.js';
 
 export interface CreateUserInput {
   email: string;
@@ -12,7 +13,11 @@ export async function createUser(input: CreateUserInput) {
   const existing = await prisma.user.findUnique({ where: { email: input.email } });
   if (existing) {
-    throw new Error('Email already in use');
+    throw new DuplicateEmailError(input.email);
   }
 
   const passwordHash = await hashPassword(input.password);
-  return prisma.user.create({
+  const user = await prisma.user.create({
     data: {
       email: input.email,
       name: input.name,
       passwordHash,
     },
+    select: {
+      id: true,
+      email: true,
+      name: true,
+      createdAt: true,
+    },
   });
+
+  logger.info({ userId: user.id }, 'User created');
+  return user;
 }
diff --git a/tests/services/user.service.test.ts b/tests/services/user.service.test.ts
new file mode 100644
index 0000000..3f4a2b1
--- /dev/null
+++ b/tests/services/user.service.test.ts
@@ -0,0 +1,42 @@
+import { describe, it, expect, beforeEach, jest } from '@jest/globals';
+import { createUser } from '../../src/services/user.service.js';
+import { prisma } from '../../src/lib/prisma.js';
+import { DuplicateEmailError } from '../../src/errors.js';
+
+jest.mock('../../src/lib/prisma.js');
+jest.mock('../../src/lib/crypto.js', () => ({
+  hashPassword: jest.fn().mockResolvedValue('hashed_password'),
+}));
+
+describe('createUser', () => {
+  beforeEach(() => {
+    jest.clearAllMocks();
+  });
+
+  it('creates a user with hashed password', async () => {
+    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
+    (prisma.user.create as jest.Mock).mockResolvedValue({
+      id: 'user-1',
+      email: 'test@example.com',
+      name: 'Test User',
+      createdAt: new Date(),
+    });
+
+    const result = await createUser({
+      email: 'test@example.com',
+      name: 'Test User',
+      password: 'secret123',
+    });
+
+    expect(result.email).toBe('test@example.com');
+    expect(prisma.user.create).toHaveBeenCalledOnce();
+  });
+
+  it('throws DuplicateEmailError when email exists', async () => {
+    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'existing' });
+
+    await expect(
+      createUser({ email: 'existing@example.com', name: 'User', password: 'pass' })
+    ).rejects.toThrow(DuplicateEmailError);
+  });
+});
```
