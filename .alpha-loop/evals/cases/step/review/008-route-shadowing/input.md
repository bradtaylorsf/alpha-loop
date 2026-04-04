# Issue #157: Build admin dashboard — eval results page

## Summary

Create the eval results page in the admin dashboard where you can view scores for a simulation, compare across runs, and drill into individual eval categories with the LLM's reasoning and evidence.

## Requirements

### `/admin/simulations/[id]/evals` — Eval Results for a Simulation

**Summary View**
- [ ] Overall score (large, color-coded: green/yellow/red)
- [ ] Radar/spider chart showing all 5 category scores
- [ ] Comparison to previous simulation's scores (if available) with delta arrows
- [ ] Eval run metadata: when run, which suite, cost of running evals
- [ ] Button to re-run evals (triggers POST to eval endpoint)

**Category Detail Cards**
For each of the 5 categories (entertainment, safety, dialogue quality, productivity, errors):
- [ ] Score with color coding
- [ ] Sub-scores breakdown (bar chart or table)
- [ ] LLM reasoning (collapsible, full text)
- [ ] Evidence section
- [ ] Links to relevant conversations/artifacts cited as evidence

### `/admin/evals` — Eval History & Comparison

- [ ] Table of all eval runs across all simulations
- [ ] Line chart: scores over time (per category) to track improvement
- [ ] Side-by-side comparison: pick 2 simulations, see scores and reasoning compared
- [ ] Export eval results as JSON

## Acceptance Criteria

- [ ] All 5 category scores displayed correctly with sub-scores
- [ ] LLM reasoning is readable and formatted
- [ ] Evidence links navigate to correct conversations/artifacts
- [ ] Re-run button triggers new eval and updates results
- [ ] Comparison view shows meaningful deltas between runs
- [ ] Score history chart shows trends over multiple simulations

## Diff to review

```diff
diff --git a/core/admin_routes.py b/core/admin_routes.py
index f6dbedc..eb9b8e0 100644
--- a/core/admin_routes.py
+++ b/core/admin_routes.py
@@ -629,28 +682,172 @@ async def get_conversation_selection_log(conv_id: uuid_mod.UUID) -> list[Selecti
     return await conv_repo.get_selection_log(conv_id)


+@router.get("/conversations/{conv_id}/overseer-flags")
+async def get_conversation_overseer_flags(conv_id: uuid_mod.UUID) -> list[dict[str, Any]]:
+    """Overseer shadow flags for this conversation."""
+    db = _get_db()
+    from core.repos.conversation_repo import ConversationRepo
+    conv_repo = ConversationRepo(db)
+    return await conv_repo.get_overseer_flags(conv_id)
+
+
+@router.get("/conversations/{conv_id}/artifacts")
+async def get_conversation_artifacts(conv_id: uuid_mod.UUID) -> list[dict[str, Any]]:
+    """Tool invocation artifacts for this conversation."""
+    db = _get_db()
+    from core.repos.conversation_repo import ConversationRepo
+    conv_repo = ConversationRepo(db)
+    return await conv_repo.get_artifacts(conv_id)
+
+
+@router.get("/conversations/{conv_id}/interrupts")
+async def get_conversation_interrupts(conv_id: uuid_mod.UUID) -> list[dict[str, Any]]:
+    """Interrupt events for this conversation."""
+    db = _get_db()
+    from core.repos.conversation_repo import ConversationRepo
+    conv_repo = ConversationRepo(db)
+    return await conv_repo.get_interrupts(conv_id)
+
+
 # ── Eval Endpoints ─────────────────────────────────────────────


 @router.get("/simulations/{sim_id}/evals")
 async def get_simulation_evals(sim_id: uuid_mod.UUID) -> list[dict[str, Any]]:
-    """All eval results for this simulation (placeholder)."""
-    return []
+    """All eval runs for this simulation with nested results."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    runs = await eval_repo.get_eval_runs(sim_id)
+    result = []
+    for run in runs:
+        results = await eval_repo.get_eval_results(run.id)
+        d = run.model_dump(mode="json")
+        d["results"] = [r.model_dump(mode="json") for r in results]
+        result.append(d)
+    return result


 @router.post("/simulations/{sim_id}/evals/run", response_model=EvalRunResponse)
 async def run_simulation_evals(sim_id: uuid_mod.UUID, body: EvalRunRequest) -> EvalRunResponse:
-    """Trigger eval run (async, returns job ID)."""
-    job_id = str(uuid_mod.uuid4())
-    return EvalRunResponse(job_id=job_id, status="queued")
+    """Trigger eval run — runs synchronously and returns results."""
+    db = _get_db()
+    llm = _get_llm()
+    from core.eval.engine import EvalEngine
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    engine = EvalEngine(db=db, llm_client=llm, eval_repo=eval_repo)
+    run_id = await engine.run(sim_id, categories=body.categories, suite=body.eval_suite)
+    run = await eval_repo.get_eval_run(run_id)
+    return EvalRunResponse(eval_run_id=str(run_id), status=run.status if run else "failed")
+
+
+@router.get("/evals")
+async def list_eval_runs(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
+    """Paginated list of all eval runs across simulations."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    runs = await eval_repo.get_all_eval_runs(limit=limit, offset=offset)
+    return [r.model_dump(mode="json") for r in runs]
+
+
+@router.get("/evals/{eval_id}")
+async def get_eval_result(eval_id: str) -> dict[str, Any]:
+    """Full eval run with all results."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    run = await eval_repo.get_eval_run(uuid_mod.UUID(eval_id))
+    if run is None:
+        raise HTTPException(status_code=404, detail="Eval run not found")
+    results = await eval_repo.get_eval_results(run.id)
+    d = run.model_dump(mode="json")
+    d["results"] = [r.model_dump(mode="json") for r in results]
+    return d
+
+
+@router.get("/evals/{eval_id}/export")
+async def export_eval(eval_id: str) -> dict[str, Any]:
+    """Export full eval results as JSON."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    run = await eval_repo.get_eval_run(uuid_mod.UUID(eval_id))
+    if run is None:
+        raise HTTPException(status_code=404, detail="Eval run not found")
+    results = await eval_repo.get_eval_results(run.id)
+    return {"eval_run": run.model_dump(mode="json"), "results": [r.model_dump(mode="json") for r in results]}
+
+
+@router.get("/evals/compare")
+async def compare_evals(run_a: str, run_b: str) -> dict[str, Any]:
+    """Side-by-side comparison of two eval runs."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    a_id = uuid_mod.UUID(run_a)
+    b_id = uuid_mod.UUID(run_b)
+    run_a_obj = await eval_repo.get_eval_run(a_id)
+    run_b_obj = await eval_repo.get_eval_run(b_id)
+    if run_a_obj is None or run_b_obj is None:
+        raise HTTPException(status_code=404, detail="One or both eval runs not found")
+    results_a = await eval_repo.get_eval_results(a_id)
+    results_b = await eval_repo.get_eval_results(b_id)
+    return {
+        "run_a": {**run_a_obj.model_dump(mode="json"), "results": [r.model_dump(mode="json") for r in results_a]},
+        "run_b": {**run_b_obj.model_dump(mode="json"), "results": [r.model_dump(mode="json") for r in results_b]},
+    }
+
+
+@router.get("/evals/history")
+async def eval_history(category: str) -> list[dict[str, Any]]:
+    """Score history for a category across all runs, for charting."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    return await eval_repo.get_eval_history(category)


 @router.get("/evals/{eval_id}")
 async def get_eval_result(eval_id: str) -> dict[str, Any]:
-    """Full eval result (placeholder)."""
-    raise HTTPException(status_code=404, detail="Eval system not yet implemented")
+    """Full eval run with all results."""
+    db = _get_db()
+    from core.repos.eval_repo import EvalRepo
+    eval_repo = EvalRepo(db)
+    run = await eval_repo.get_eval_run(uuid_mod.UUID(eval_id))
+    if run is None:
+        raise HTTPException(status_code=404, detail="Eval run not found")
+    results = await eval_repo.get_eval_results(run.id)
+    d = run.model_dump(mode="json")
+    d["results"] = [r.model_dump(mode="json") for r in results]
+    return d
```

The frontend components consuming these endpoints:

```typescript
// ScoreHistoryChart.tsx — fires 5 parallel requests on mount
useEffect(() => {
  const categories = ['entertainment', 'safety', 'dialogue', 'productivity', 'errors'];
  Promise.all(
    categories.map(cat =>
      fetch(`/api/admin/evals/history?category=${cat}`).then(r => r.json())
    )
  ).then(setHistoryData);
}, []);

// ComparisonPanel.tsx
const compareEvals = async (runA: string, runB: string) => {
  const res = await fetch(`/api/admin/evals/compare?run_a=${runA}&run_b=${runB}`);
  return res.json();
};
```
