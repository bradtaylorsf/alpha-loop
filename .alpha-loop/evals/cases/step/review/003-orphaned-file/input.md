```diff
diff --git a/src/utils/format.ts b/src/utils/format.ts
new file mode 100644
index 0000000..7c3a1b2
--- /dev/null
+++ b/src/utils/format.ts
@@ -0,0 +1,24 @@
+/**
+ * Utility functions for formatting display values
+ */
+
+export function formatDate(date: Date): string {
+  return date.toLocaleDateString('en-US', {
+    year: 'numeric',
+    month: 'long',
+    day: 'numeric',
+  });
+}
+
+export function formatCurrency(amount: number, currency = 'USD'): string {
+  return new Intl.NumberFormat('en-US', {
+    style: 'currency',
+    currency,
+  }).format(amount);
+}
+
+export function truncate(text: string, maxLength: number): string {
+  if (text.length <= maxLength) return text;
+  return `${text.slice(0, maxLength - 3)}...`;
+}
diff --git a/src/controllers/order.controller.ts b/src/controllers/order.controller.ts
index 4b2c3d1..9e8f7a2 100644
--- a/src/controllers/order.controller.ts
+++ b/src/controllers/order.controller.ts
@@ -1,6 +1,7 @@
 import { Request, Response } from 'express';
 import { orderService } from '../services/order.service.js';
+import { logger } from '../lib/logger.js';
 
 export const orderController = {
   async getOrder(req: Request, res: Response) {
@@ -10,6 +11,7 @@ export const orderController = {
       if (!order) {
         return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
       }
+      logger.info({ orderId: req.params.id }, 'Order retrieved');
       res.json({ data: order });
     } catch (err) {
       res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
```
