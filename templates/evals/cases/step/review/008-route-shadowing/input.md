## Issue: Add eval comparison endpoint

### Diff

```diff
+++ b/src/routes/evals.ts
@@ -5,6 +5,11 @@
 const router = express.Router();

 router.get('/evals/:id', async (req, res) => {
   const eval = await evalService.findById(req.params.id);
   res.json(eval);
 });

+router.get('/evals/compare', async (req, res) => {
+  const { run1, run2 } = req.query;
+  const comparison = await evalService.compare(String(run1), String(run2));
+  res.json(comparison);
+});
+
+router.get('/evals/summary', async (req, res) => {
+  const summary = await evalService.getSummary();
+  res.json(summary);
+});
```

### Analysis Required

Review this diff. The issue asked to add an eval comparison endpoint.
