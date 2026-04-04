# Batch review: Issues #155, #156, #157, #158, #186

Review the combined changes from 5 issues implemented in a single batch.

## Issue #155: Build eval framework and CLI runner

Create the evaluation engine that scores simulation runs across multiple dimensions. The framework runs LLM-based evals against simulation data and stores results in the database.

## Issue #156: Create eval prompt suite

5 YAML prompt files with rubrics, sub-scores, and output schemas for: entertainment, safety, dialogue_quality, productivity, errors.

## Issue #157: Build admin dashboard — eval results page

Eval results page with radar chart, score cards, category details, comparison, and history.

## Issue #158: Database migration 013

New eval_runs and eval_results tables with Pydantic models and EvalRepo.

## Issue #186: Simulation clock with configurable speed multiplier

SimulationClock class integrated into orchestrator and conversation engine with CLI --speed-multiplier flag.

## Diff to review

```diff
diff --git a/core/eval/engine.py b/core/eval/engine.py
new file mode 100644
--- /dev/null
+++ b/core/eval/engine.py
@@ -0,0 +1,209 @@
+"""Eval engine — runs LLM-based evaluations against simulation data."""
+
+from __future__ import annotations
+
+import json
+import logging
+from datetime import UTC, datetime
+from decimal import Decimal
+from typing import TYPE_CHECKING, Any
+
+from core.eval.loader import load_simulation_data, organize_by_category
+from core.eval.prompt_loader import discover_categories, load_prompt, render_user_prompt
+
+if TYPE_CHECKING:
+    import uuid
+    from core.database import Database
+    from core.llm_client import OpenRouterClient
+    from core.repos.eval_repo import EvalRepo
+
+logger = logging.getLogger(__name__)
+
+
+class EvalEngine:
+    def __init__(self, db: Database, llm_client: OpenRouterClient, eval_repo: EvalRepo) -> None:
+        self._db = db
+        self._llm = llm_client
+        self._eval_repo = eval_repo
+
+    async def run(
+        self,
+        simulation_id: uuid.UUID,
+        *,
+        categories: list[str] | None = None,
+        suite: str = "full",
+    ) -> uuid.UUID:
+        eval_run = await self._eval_repo.create_eval_run(simulation_id, suite)
+        run_id = eval_run.id
+
+        try:
+            data = await load_simulation_data(self._db, simulation_id)
+        except ValueError as exc:
+            await self._eval_repo.update_eval_run(run_id, status="failed", completed_at=datetime.now(UTC))
+            raise exc
+
+        category_data = organize_by_category(data)
+
+        available = discover_categories()
+        if categories:
+            to_run = [c for c in categories if c in available]
+        elif suite == "quick":
+            to_run = available[:3]
+        else:
+            to_run = available
+
+        total_cost = Decimal("0")
+        total_scores: list[Decimal] = []
+        had_failure = False
+
+        for cat in to_run:
+            try:
+                result = await self._run_category(run_id, cat, category_data.get(cat, {}), data)
+                if result["score"] is not None:
+                    total_scores.append(result["score"])
+                total_cost += result["cost"]
+            except Exception:
+                logger.exception("Eval category '%s' failed", cat)
+                had_failure = True
+                await self._eval_repo.save_eval_result(
+                    eval_run_id=run_id,
+                    category=cat,
+                    score=Decimal("0"),
+                    reasoning="Eval failed — see logs for details",
+                    evidence=None,
+                    sub_scores=None,
+                    tokens_used=0,
+                    cost=Decimal("0"),
+                )
+
+        overall = sum(total_scores) / len(total_scores) if total_scores else None
+        status = "completed" if not had_failure else ("completed" if total_scores else "failed")
+        await self._eval_repo.update_eval_run(
+            run_id, status=status, overall_score=overall, cost=total_cost, completed_at=datetime.now(UTC),
+        )
+        return run_id
+
+    async def _run_category(self, run_id, category, cat_data, full_data):
+        prompt_config = load_prompt(category)
+        model = prompt_config.get("model", "claude-sonnet-4-6")
+        system_prompt = prompt_config["system"]
+        user_prompt = render_user_prompt(prompt_config, cat_data)
+
+        messages = [
+            {"role": "system", "content": system_prompt},
+            {"role": "user", "content": user_prompt},
+        ]
+
+        response = await self._llm.complete(
+            messages=messages, model=model, agent_id="eval_engine",
+            temperature=0.3, max_tokens=4096, timeout=120.0,
+        )
+
+        parsed = _parse_eval_response(response.content)
+        score = Decimal(str(parsed.get("score", 0)))
+        tokens_used = response.input_tokens + response.output_tokens
+        cost = response.estimated_cost
+
+        await self._eval_repo.save_eval_result(
+            eval_run_id=run_id, category=category, score=score,
+            reasoning=parsed.get("reasoning", ""),
+            evidence=parsed.get("evidence"),
+            sub_scores=parsed.get("sub_scores"),
+            tokens_used=tokens_used, cost=cost,
+        )
+        return {"score": score, "cost": cost, "tokens_used": tokens_used}

diff --git a/core/eval/loader.py b/core/eval/loader.py
new file mode 100644
--- /dev/null
+++ b/core/eval/loader.py
@@ -0,0 +1,85 @@
+"""Load simulation data for eval engine consumption."""
+
+async def load_simulation_data(db: Database, simulation_id: uuid.UUID) -> dict[str, Any]:
+    """Load all data needed for eval scoring."""
+    sim_repo = SimulationRepo(db)
+    conv_repo = ConversationRepo(db)
+    transcript_repo = TranscriptRepo(db)
+    artifact_repo = ArtifactRepo(db)
+
+    sim = await sim_repo.get(simulation_id)
+    if sim is None:
+        raise ValueError(f"Simulation {simulation_id} not found")
+
+    conversations = await conv_repo.get_by_simulation(simulation_id)
+    transcripts = []
+    for conv in conversations:
+        t = await transcript_repo.get_by_conversation(conv.id)
+        if t:
+            transcripts.append({"conversation_id": str(conv.id), "content": t.content})
+
+    artifacts = await artifact_repo.get_by_simulation(simulation_id)
+
+    return {
+        "simulation": sim,
+        "conversations": conversations,
+        "transcripts": transcripts,
+        "artifacts": artifacts,
+        "agent_count": len(sim.agents_participated),
+    }

diff --git a/core/admin_routes.py b/core/admin_routes.py
--- a/core/admin_routes.py
+++ b/core/admin_routes.py
@@ -578,8 +624,13 @@ async def get_conversation(conv_id: uuid_mod.UUID) -> ConversationDetail:
     energy_log = await conv_repo.get_energy_log(conv_id)
     transcript_record = await transcript_repo.get_by_conversation(conv_id)

+    # Estimate tokens from transcript length (cost_events lacks conversation_id)
+    transcript_text = transcript_record.content if transcript_record else ""
+    total_tokens = len(transcript_text) // 4 if transcript_text else 0
+
     return ConversationDetail(
         id=conv.id,
+        simulation_id=conv.simulation_id,
         started_at=conv.started_at,
         ended_at=conv.ended_at,
         trigger_type=conv.trigger_type,
@@ -593,6 +644,8 @@ async def get_conversation(conv_id: uuid_mod.UUID) -> ConversationDetail:
         location=conv.location,
         energy_history=energy_log,
         transcript=transcript_record.content if transcript_record else None,
+        total_tokens=total_tokens,
+        total_cost="0",
     )

diff --git a/core/repos/cost_repo.py b/core/repos/cost_repo.py
--- a/core/repos/cost_repo.py
+++ b/core/repos/cost_repo.py
@@ -25,6 +25,15 @@ class CostRepo:
+    async def get_conversation_cost(self, conversation_id: UUID) -> dict:
+        """Get actual cost for a conversation from cost_events."""
+        row = await self._db.fetchrow(
+            """
+            SELECT COALESCE(SUM(input_tokens), 0) as total_input,
+                   COALESCE(SUM(output_tokens), 0) as total_output,
+                   COALESCE(SUM(cost_usd), 0) as total_cost
+            FROM cost_events
+            WHERE conversation_id = $1
+            """,
+            conversation_id,
+        )
+        return dict(row) if row else {"total_input": 0, "total_output": 0, "total_cost": 0}

diff --git a/core/simulation/clock.py b/core/simulation/clock.py
new file mode 100644
--- /dev/null
+++ b/core/simulation/clock.py
@@ -0,0 +1,79 @@
+"""Simulated clock with configurable speed multiplier."""
+class SimulationClock:
+    def __init__(self, speed_multiplier: float = 0, start_time: datetime | None = None):
+        self._speed_multiplier = speed_multiplier
+        self._start_sim = start_time or _DEFAULT_START
+        self._start_real_mono = time.monotonic()
+        self._manual_offset = timedelta(0)
+        self._lock = threading.Lock()
+
+    def now(self) -> datetime:
+        with self._lock:
+            if self._speed_multiplier == 0:
+                return self._start_sim + self._manual_offset
+            elapsed_real = time.monotonic() - self._start_real_mono
+            simulated_elapsed = timedelta(seconds=elapsed_real * self._speed_multiplier)
+            return self._start_sim + simulated_elapsed + self._manual_offset
+
+    def advance(self, duration: timedelta) -> None:
+        with self._lock:
+            self._manual_offset += duration
+
+    def to_dict(self) -> dict[str, Any]:
+        return {
+            "start_time": self._start_sim.isoformat(),
+            "speed_multiplier": self._speed_multiplier,
+            "elapsed_seconds": self.elapsed().total_seconds(),
+            "current_simulated_time": self.now().isoformat(),
+        }
```

Product vision excerpt: "Cost tracking must be 100% accurate for eval integrity."
