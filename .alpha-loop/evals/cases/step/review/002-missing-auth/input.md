```diff
diff --git a/src/routes/admin.ts b/src/routes/admin.ts
index c9a1b2d..f3e7a81 100644
--- a/src/routes/admin.ts
+++ b/src/routes/admin.ts
@@ -1,12 +1,30 @@
 import { Router } from 'express';
-import { authenticate, requireRole } from '../middleware/auth.js';
+import { authenticate, requireRole } from '../middleware/auth.js';
 import { adminController } from '../controllers/admin.controller.js';
+import { userController } from '../controllers/user.controller.js';
 
 const router = Router();
 
 // Existing admin routes — all protected
 router.get('/admin/stats', authenticate, requireRole('admin'), adminController.getStats);
 router.delete('/admin/users/:id', authenticate, requireRole('admin'), adminController.deleteUser);
+
+// New endpoint: create a user from the admin panel
+router.post('/admin/users', userController.createUser);
 
 export default router;
```
