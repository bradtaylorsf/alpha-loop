## Issue: Add cost tracking to pipeline runs

### Diff

```diff
+++ b/src/services/cost-tracker.ts
@@ -0,0 +1,22 @@
+export class CostTracker {
+  async trackRun(runId: string, model: string, output: string): Promise<CostRecord> {
+    // Estimate tokens from output length
+    const estimatedTokens = Math.ceil(output.length / 4);
+    const estimatedInputTokens = estimatedTokens * 2;
+
+    const cost = this.calculateCost(model, estimatedInputTokens, estimatedTokens);
+
+    return {
+      runId,
+      model,
+      inputTokens: estimatedInputTokens,
+      outputTokens: estimatedTokens,
+      costUsd: cost,
+    };
+  }
+
+  private calculateCost(model: string, input: number, output: number): number {
+    const rates: Record<string, number> = { 'gpt-4': 0.03, 'claude': 0.015 };
+    return (input + output) * (rates[model] ?? 0.01) / 1000;
+  }
+}

+++ b/src/components/CostDashboard.tsx
@@ -0,0 +1,15 @@
+export function CostDashboard({ runs }: { runs: CostRecord[] }) {
+  const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
+  return (
+    <div>
+      <h2>Cost Summary</h2>
+      <p>Total: ${totalCost.toFixed(2)}</p>
+      {runs.map(r => (
+        <div key={r.runId}>
+          <span>{r.model}: {r.inputTokens} in / {r.outputTokens} out</span>
+          <span>${r.costUsd.toFixed(4)}</span>
+        </div>
+      ))}
+    </div>
+  );
+}
```

### Analysis Required

Review this diff. The issue asked for cost tracking of pipeline runs.
