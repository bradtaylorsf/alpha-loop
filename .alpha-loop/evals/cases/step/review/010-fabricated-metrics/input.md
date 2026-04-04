# Batch review: Issues #155, #156, #157, #158, #186

Review the combined changes from 5 issues. Focus on the eval engine implementation.

## Issue #155: Build eval framework and CLI runner

Database schema, eval engine, CLI runner, admin routes.

## Issue #158: Database migration 013

New eval_runs and eval_results tables.

## Diff to review (eval engine and data loading)

```diff
diff --git a/core/eval/engine.py b/core/eval/engine.py
new file mode 100644
--- /dev/null
+++ b/core/eval/engine.py
@@ -0,0 +1,160 @@
+"""Eval engine — runs LLM-based evaluations against simulation data."""
+
+class EvalEngine:
+    def __init__(self, db, llm_client, eval_repo):
+        self._db = db
+        self._llm = llm_client
+        self._eval_repo = eval_repo
+
+    async def run(self, simulation_id, *, categories=None, suite="full"):
+        eval_run = await self._eval_repo.create_eval_run(simulation_id, suite)
+        run_id = eval_run.id
+
+        data = await load_simulation_data(self._db, simulation_id)
+        category_data = organize_by_category(data)
+
+        available = discover_categories()
+        if categories:
+            to_run = [c for c in categories if c in available]
+        elif suite == "quick":
+            to_run = available[:3]  # first 3 alphabetically
+        else:
+            to_run = available
+
+        total_cost = Decimal("0")
+        total_scores = []
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
+                    eval_run_id=run_id, category=cat,
+                    score=Decimal("0"),
+                    reasoning="Eval failed — see logs for details",
+                    evidence=None, sub_scores=None,
+                    tokens_used=0, cost=Decimal("0"),
+                )
+
+        overall = sum(total_scores) / len(total_scores) if total_scores else None
+        await self._eval_repo.update_eval_run(
+            run_id, status="completed" if not had_failure else "failed",
+            overall_score=overall, cost=total_cost, completed_at=datetime.now(UTC),
+        )
+        return run_id
+
+    async def _run_category(self, run_id, category, cat_data, full_data):
+        prompt_config = load_prompt(category)
+        response = await self._llm.complete(
+            messages=[
+                {"role": "system", "content": prompt_config["system"]},
+                {"role": "user", "content": render_user_prompt(prompt_config, cat_data)},
+            ],
+            model=prompt_config.get("model", "claude-sonnet-4-6"),
+            agent_id="eval_engine", temperature=0.3, max_tokens=4096,
+        )
+
+        parsed = _parse_eval_response(response.content)
+        score = Decimal(str(parsed.get("score", 0)))
+        cost = response.estimated_cost
+
+        await self._eval_repo.save_eval_result(
+            eval_run_id=run_id, category=category, score=score,
+            reasoning=parsed.get("reasoning", ""),
+            evidence=parsed.get("evidence"), sub_scores=parsed.get("sub_scores"),
+            tokens_used=response.input_tokens + response.output_tokens,
+            cost=cost,
+        )
+        return {"score": score, "cost": cost}

diff --git a/core/eval/loader.py b/core/eval/loader.py
new file mode 100644
--- /dev/null
+++ b/core/eval/loader.py
@@ -0,0 +1,85 @@
+"""Load simulation data for eval engine consumption."""
+
+async def load_simulation_data(db, simulation_id):
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
+        "artifacts": artifacts,  # This list will always be empty (see note below)
+        "agent_count": len(sim.agents_participated),
+    }
+
+def organize_by_category(data):
+    return {
+        "entertainment": {
+            "transcripts": data["transcripts"],
+            "conversations": data["conversations"],
+        },
+        "safety": {"transcripts": data["transcripts"]},
+        "dialogue_quality": {
+            "transcripts": data["transcripts"],
+            "conversations": data["conversations"],
+        },
+        "productivity": {
+            "artifacts": data["artifacts"],
+            "conversations": data["conversations"],
+        },
+        "errors": {
+            "conversations": data["conversations"],
+            "transcripts": data["transcripts"],
+        },
+    }

diff --git a/core/eval/prompts/productivity.yaml b/core/eval/prompts/productivity.yaml
new file mode 100644
--- /dev/null
+++ b/core/eval/prompts/productivity.yaml
@@ -0,0 +1,40 @@
+name: productivity
+description: "Evaluate agent productivity — tool usage, task completion, artifact creation"
+model: claude-sonnet-4-6
+system: |
+  You are evaluating the productivity of AI agents in a simulation.
+  Score based on: tool usage diversity, artifact quality, task completion rate.
+user_template: |
+  ## Artifacts Created
+  {{artifacts | length}} artifacts produced during this simulation.
+  {% for a in artifacts %}
+  - {{a.tool_name}}: {{a.status}} (by {{a.agent_id}})
+  {% endfor %}
+
+  ## Conversations
+  {{conversations | length}} conversations held.
+rubric:
+  - name: tool_diversity
+    weight: 0.3
+    description: "How many different tools were used?"
+  - name: artifact_quality
+    weight: 0.4
+    description: "Are artifacts meaningful and complete?"
+  - name: task_completion
+    weight: 0.3
+    description: "Were tasks started and finished?"
+output_schema:
+  score: "0-100"
+  sub_scores:
+    tool_diversity: "0-100"
+    artifact_quality: "0-100"
+    task_completion: "0-100"
+  reasoning: "string"
+  evidence: "list of specific examples"
```

The `productivity` eval prompt expects artifacts to score tool_diversity and artifact_quality. The eval engine passes `data["artifacts"]` to this prompt. The loader creates an ArtifactRepo and queries `get_by_simulation()` to populate the artifacts list.
