```diff
diff --git a/src/services/notification.service.ts b/src/services/notification.service.ts
new file mode 100644
index 0000000..b4e1f93
--- /dev/null
+++ b/src/services/notification.service.ts
@@ -0,0 +1,35 @@
+import axios from 'axios';
+
+const API_KEY = 'sk-live-abc123xyz';
+const BASE_URL = 'https://api.notifications.example.com/v1';
+
+export interface NotificationPayload {
+  userId: string;
+  title: string;
+  body: string;
+  channel: 'email' | 'push' | 'sms';
+}
+
+export async function sendNotification(payload: NotificationPayload): Promise<void> {
+  await axios.post(`${BASE_URL}/send`, payload, {
+    headers: {
+      Authorization: `Bearer ${API_KEY}`,
+      'Content-Type': 'application/json',
+    },
+  });
+}
+
+export async function sendBulkNotifications(
+  payloads: NotificationPayload[]
+): Promise<void> {
+  await axios.post(`${BASE_URL}/bulk`, { notifications: payloads }, {
+    headers: {
+      Authorization: `Bearer ${API_KEY}`,
+      'Content-Type': 'application/json',
+    },
+  });
+}
```
