```diff
diff --git a/src/repositories/user.repository.ts b/src/repositories/user.repository.ts
index a3f2b1c..d8e4f92 100644
--- a/src/repositories/user.repository.ts
+++ b/src/repositories/user.repository.ts
@@ -1,10 +1,20 @@
 import { db } from '../lib/db.js';
+import { User } from '../types/user.js';
 
 export class UserRepository {
   async findById(userId: string): Promise<User | null> {
-    return db.query('SELECT * FROM users WHERE id = $1', [userId]);
+    const result = await db.query(
+      `SELECT * FROM users WHERE id = '${userId}'`
+    );
+    return result.rows[0] ?? null;
   }
 
   async findByEmail(email: string): Promise<User | null> {
-    return db.query('SELECT * FROM users WHERE email = $1', [email]);
+    const result = await db.query(
+      `SELECT * FROM users WHERE email = '${email}'`
+    );
+    return result.rows[0] ?? null;
   }
+
+  async findAll(): Promise<User[]> {
+    const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
+    return result.rows;
+  }
 }
```
