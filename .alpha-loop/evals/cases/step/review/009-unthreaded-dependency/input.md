## Issue: Add analytics dashboard showing tool execution metrics

### Diff

```diff
+++ b/src/routes/analytics.ts
@@ -0,0 +1,20 @@
+import { AnalyticsRepository } from '../repos/analytics-repo';
+
+const router = express.Router();
+
+router.get('/analytics/tools', async (req, res) => {
+  const metrics = await analyticsRepo.getToolMetrics();
+  res.json(metrics);
+});
+
+router.get('/analytics/tools/:toolId', async (req, res) => {
+  const history = await analyticsRepo.getToolHistory(req.params.toolId);
+  res.json(history);
+});

+++ b/src/repos/analytics-repo.ts
@@ -0,0 +1,18 @@
+export class AnalyticsRepository {
+  constructor(private db: Database) {}
+
+  async getToolMetrics(): Promise<ToolMetric[]> {
+    return this.db.query('SELECT tool_name, count(*) as runs, avg(duration) as avg_duration FROM tool_executions GROUP BY tool_name');
+  }
+
+  async getToolHistory(toolId: string): Promise<ToolExecution[]> {
+    return this.db.query('SELECT * FROM tool_executions WHERE tool_name = ? ORDER BY created_at DESC LIMIT 50', [toolId]);
+  }
+}

+++ b/src/components/AnalyticsDashboard.tsx
@@ -0,0 +1,30 @@
+export function AnalyticsDashboard() {
+  const { data: metrics } = useQuery('/analytics/tools');
+  return (
+    <div>
+      <h1>Tool Analytics</h1>
+      {metrics?.map(m => (
+        <div key={m.tool_name}>
+          <span>{m.tool_name}</span>
+          <span>{m.runs} runs</span>
+          <span>{m.avg_duration}ms avg</span>
+        </div>
+      ))}
+    </div>
+  );
+}
```

### Analysis Required

Review this diff. The issue asked for an analytics dashboard showing tool execution metrics.
