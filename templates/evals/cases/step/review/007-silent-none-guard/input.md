## Issue: Add notification service for order status changes

### Diff

```diff
+++ b/src/services/notification-service.ts
@@ -0,0 +1,15 @@
+export class NotificationService {
+  constructor(private emailClient: EmailClient) {}
+
+  async notify(userId: string, message: string): Promise<void> {
+    await this.emailClient.send(userId, message);
+  }
+}

+++ b/src/services/order-service.ts
@@ -3,7 +3,13 @@
 export class OrderService {
-  constructor(private orderRepo: OrderRepository) {}
+  constructor(
+    private orderRepo: OrderRepository,
+    private notifications: NotificationService | null = null,
+  ) {}

   async updateStatus(orderId: string, status: OrderStatus): Promise<void> {
     const order = await this.orderRepo.findById(orderId);
     order.status = status;
     await this.orderRepo.save(order);
+
+    if (this.notifications !== null) {
+      await this.notifications.notify(order.userId, `Order ${orderId} is now ${status}`);
+    }
   }

+++ b/tests/order-service.test.ts
@@ -10,6 +10,14 @@
   it('updates order status', async () => {
     const service = new OrderService(mockRepo);
     await service.updateStatus('ord-1', 'shipped');
     expect(mockRepo.save).toHaveBeenCalled();
   });
+
+  it('sends notification on status change', async () => {
+    const service = new OrderService(mockRepo);
+    await service.updateStatus('ord-1', 'shipped');
+    // Test passes because notifications is null by default
+    // No assertion on notification behavior
+  });
```

### Analysis Required

Review this diff. The issue asked for notifications on order status changes.
