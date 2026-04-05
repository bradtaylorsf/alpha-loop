# Issue #195: Day-over-day comparison for simulation runs

## Summary

Add the ability to compare two simulation runs side-by-side, showing what
changed between them (conversation patterns, agent behavior, metrics).

## Acceptance Criteria

- [ ] Compare two simulation runs by name or ID
- [ ] Show differences in conversation counts, agent participation, topics
- [ ] CLI command for running comparisons
- [ ] Structured output suitable for reports

## Diff to review

```diff
diff --git a/reporting/cross_run_comparison.py b/reporting/cross_run_comparison.py
new file mode 100644
--- /dev/null
+++ b/reporting/cross_run_comparison.py
@@ -0,0 +1,148 @@
+"""Cross-run comparison — detailed analysis of differences between simulation runs."""
+
+from __future__ import annotations
+
+import logging
+from dataclasses import dataclass, field
+from typing import Any
+
+logger = logging.getLogger(__name__)
+
+
+@dataclass
+class AgentComparison:
+    agent_id: str
+    run_a_conversations: int
+    run_b_conversations: int
+    delta: int
+    run_a_topics: list[str]
+    run_b_topics: list[str]
+    new_topics: list[str]
+    dropped_topics: list[str]
+
+
+@dataclass
+class CategoryComparison:
+    category: str
+    run_a_score: float
+    run_b_score: float
+    delta: float
+    trend: str  # "improved", "declined", "stable"
+
+
+class CrossRunComparison:
+    """Detailed comparison between two simulation runs."""
+
+    def __init__(self, run_a_data: dict, run_b_data: dict):
+        self._run_a = run_a_data
+        self._run_b = run_b_data
+
+    def compare(self) -> dict[str, Any]:
+        """Generate full comparison report."""
+        return {
+            "overview": self._compare_overview(),
+            "agents": self._compare_agents(),
+            "categories": self._compare_categories(),
+            "conversations": self._compare_conversations(),
+            "recommendations": self._generate_recommendations(),
+        }
+
+    def _compare_overview(self) -> dict:
+        a_convs = len(self._run_a.get("conversations", []))
+        b_convs = len(self._run_b.get("conversations", []))
+        a_agents = len(self._run_a.get("agents", []))
+        b_agents = len(self._run_b.get("agents", []))
+        return {
+            "run_a_conversations": a_convs,
+            "run_b_conversations": b_convs,
+            "conversation_delta": b_convs - a_convs,
+            "run_a_agents": a_agents,
+            "run_b_agents": b_agents,
+            "agent_delta": b_agents - a_agents,
+        }
+
+    def _compare_agents(self) -> list[AgentComparison]:
+        a_agents = {a["agent_id"]: a for a in self._run_a.get("agents", [])}
+        b_agents = {a["agent_id"]: a for a in self._run_b.get("agents", [])}
+        all_ids = sorted(set(a_agents) | set(b_agents))
+        results = []
+        for aid in all_ids:
+            a = a_agents.get(aid, {})
+            b = b_agents.get(aid, {})
+            a_topics = set(a.get("topics", []))
+            b_topics = set(b.get("topics", []))
+            results.append(AgentComparison(
+                agent_id=aid,
+                run_a_conversations=a.get("conversation_count", 0),
+                run_b_conversations=b.get("conversation_count", 0),
+                delta=b.get("conversation_count", 0) - a.get("conversation_count", 0),
+                run_a_topics=list(a_topics),
+                run_b_topics=list(b_topics),
+                new_topics=list(b_topics - a_topics),
+                dropped_topics=list(a_topics - b_topics),
+            ))
+        return results
+
+    def _compare_categories(self) -> list[CategoryComparison]:
+        a_cats = {c["name"]: c for c in self._run_a.get("eval_scores", [])}
+        b_cats = {c["name"]: c for c in self._run_b.get("eval_scores", [])}
+        results = []
+        for cat in sorted(set(a_cats) | set(b_cats)):
+            a_score = a_cats.get(cat, {}).get("score", 0)
+            b_score = b_cats.get(cat, {}).get("score", 0)
+            delta = b_score - a_score
+            trend = "improved" if delta > 5 else ("declined" if delta < -5 else "stable")
+            results.append(CategoryComparison(
+                category=cat, run_a_score=a_score, run_b_score=b_score,
+                delta=delta, trend=trend,
+            ))
+        return results
+
+    def _compare_conversations(self) -> dict:
+        return {
+            "run_a_count": len(self._run_a.get("conversations", [])),
+            "run_b_count": len(self._run_b.get("conversations", [])),
+        }
+
+    def _generate_recommendations(self) -> list[str]:
+        recs = []
+        overview = self._compare_overview()
+        if overview["conversation_delta"] < 0:
+            recs.append("Conversation count dropped — check phase scheduling")
+        cats = self._compare_categories()
+        declined = [c for c in cats if c.trend == "declined"]
+        if declined:
+            recs.append(f"Categories declined: {', '.join(c.category for c in declined)}")
+        return recs


diff --git a/reporting/timeline_reporter.py b/reporting/timeline_reporter.py
--- a/reporting/timeline_reporter.py
+++ b/reporting/timeline_reporter.py
@@ -65,0 +66,12 @@
+    def compare(self, other: "TimelineReporter") -> dict[str, Any]:
+        """Compare two timeline reports for day-over-day analysis."""
+        current = self.generate()
+        previous = other.generate()
+        return {
+            "current_count": current["total_conversations"],
+            "previous_count": previous["total_conversations"],
+            "delta": current["total_conversations"] - previous["total_conversations"],
+        }


diff --git a/scripts/compare_runs.py b/scripts/compare_runs.py
new file mode 100644
--- /dev/null
+++ b/scripts/compare_runs.py
@@ -0,0 +1,48 @@
+#!/usr/bin/env python3
+"""Compare two simulation runs.
+
+Usage:
+    python scripts/compare_runs.py --run-a "baseline" --run-b "improved"
+"""
+
+import argparse
+import asyncio
+import json
+import sys
+from pathlib import Path
+
+PROJECT_ROOT = Path(__file__).resolve().parent.parent
+sys.path.insert(0, str(PROJECT_ROOT))
+
+from dotenv import load_dotenv
+load_dotenv(PROJECT_ROOT / ".env")
+
+
+async def main(args):
+    from core.bootstrap import bootstrap_services, shutdown_services
+    from core.repos.simulation_repo import SimulationRepo
+    from core.repos.conversation_repo import ConversationRepo
+    from reporting.timeline_reporter import TimelineReporter
+
+    svc = await bootstrap_services()
+    sim_repo = SimulationRepo(svc.db)
+    conv_repo = ConversationRepo(svc.db)
+
+    sim_a = await sim_repo.get_by_name(args.run_a)
+    sim_b = await sim_repo.get_by_name(args.run_b)
+
+    convs_a = await conv_repo.get_by_simulation(sim_a.id)
+    convs_b = await conv_repo.get_by_simulation(sim_b.id)
+
+    reporter_a = TimelineReporter([c.model_dump() for c in convs_a], sim_start=sim_a.started_at)
+    reporter_b = TimelineReporter([c.model_dump() for c in convs_b], sim_start=sim_b.started_at)
+
+    result = reporter_a.compare(reporter_b)
+    print(json.dumps(result, indent=2, default=str))
+
+    await shutdown_services(svc)
+
+
+if __name__ == "__main__":
+    parser = argparse.ArgumentParser()
+    parser.add_argument("--run-a", required=True)
+    parser.add_argument("--run-b", required=True)
+    asyncio.run(main(parser.parse_args()))


diff --git a/tests/test_cross_run_comparison.py b/tests/test_cross_run_comparison.py
new file mode 100644
--- /dev/null
+++ b/tests/test_cross_run_comparison.py
@@ -0,0 +1,52 @@
+"""Tests for CrossRunComparison."""
+from reporting.cross_run_comparison import CrossRunComparison
+
+class TestCrossRunComparison:
+    def test_compare_overview(self):
+        comp = CrossRunComparison(
+            {"conversations": [1, 2, 3], "agents": [{"agent_id": "a"}]},
+            {"conversations": [1, 2, 3, 4, 5], "agents": [{"agent_id": "a"}, {"agent_id": "b"}]},
+        )
+        result = comp.compare()
+        assert result["overview"]["conversation_delta"] == 2
+        assert result["overview"]["agent_delta"] == 1
+
+    def test_compare_categories(self):
+        comp = CrossRunComparison(
+            {"eval_scores": [{"name": "safety", "score": 80}]},
+            {"eval_scores": [{"name": "safety", "score": 90}]},
+        )
+        result = comp.compare()
+        cats = result["categories"]
+        assert len(cats) == 1
+        assert cats[0].trend == "improved"
+
+    def test_recommendations(self):
+        comp = CrossRunComparison(
+            {"conversations": [1, 2, 3]},
+            {"conversations": [1]},
+        )
+        result = comp.compare()
+        assert any("dropped" in r.lower() for r in result["recommendations"])
```

Note: `compare_runs.py` imports `TimelineReporter` and calls `.compare()`. It does NOT import `CrossRunComparison`. The `CrossRunComparison` class is only imported in its test file.
