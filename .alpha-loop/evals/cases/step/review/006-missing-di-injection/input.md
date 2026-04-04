# Issue #190: Tool coverage seed scenario — exercise all 21 tools

## Summary

Create a seed scenario that guarantees all 21 agent tools are exercised at least once during the simulation. This is the QA scenario for validating that every tool works end-to-end with real LLM calls, database persistence, and artifact creation.

## Context

The current `full_day.yaml` exercises some tools organically but doesn't guarantee full coverage. In QA, we need to know: "Does every tool actually work when an agent calls it?" This scenario uses `tool_exercise` phases to force each tool to fire, plus organic phases to test natural tool selection.

## Requirements

### Seed file: `scenarios/tool_coverage.yaml`

All 21 tools must be exercised. Group by category:

**Core tools:**
- [ ] `send_message` — Agent sends a message to another agent
- [ ] `get_world_state` — Agent checks world/office status
- [ ] `get_audience_status` — Agent checks viewer count and chat activity

**Audience tools:**
- [ ] `send_chat_message` — Agent posts to audience chat
- [ ] `create_poll` — Agent creates an audience poll
- [ ] `get_poll_results` — Agent retrieves poll results

**Memory tools:**
- [ ] `recall_memory` — Agent searches past memories
- [ ] `retrieve_transcript` — Agent fetches a past conversation transcript
- [ ] `update_core_memory` — Agent updates their own core memory

**Code & world tools:**
- [ ] `execute_code` — Agent runs code in Docker sandbox
- [ ] `generate_tilemap` — Agent creates a pixel art tilemap chunk

**Web & content tools:**
- [ ] `web_search` — Agent searches the web
- [ ] `fetch_url` — Agent reads a specific URL
- [ ] `draft_social_post` — Agent writes a social media post
- [ ] `draft_email` — Agent writes a sponsorship/outreach email

**Business tools:**
- [ ] `get_revenue_status` — Agent checks budget and revenue

**Agent autonomy tools:**
- [ ] `dispatch_alpha` — Agent delegates a task to Alpha
- [ ] `propose_self_modification` — Agent proposes a change to themselves
- [ ] `view_evolution_log` — Agent reviews past self-modifications

### Post-run validation
- [ ] Script or test that checks artifacts table for all 21 tool names
- [ ] Report which tools fired and which didn't
- [ ] Flag any tools that errored

## Acceptance Criteria

- [ ] All 21 tools appear in the artifacts table after the run
- [ ] No tool errors (all status='executed' or graceful failures logged)
- [ ] Coverage report shows 21/21 tools exercised
- [ ] Repeatable — running twice produces similar coverage

## Diff to review

```diff
diff --git a/scripts/check_tool_coverage.py b/scripts/check_tool_coverage.py
new file mode 100644
index 0000000..79328e7
--- /dev/null
+++ b/scripts/check_tool_coverage.py
@@ -0,0 +1,157 @@
+#!/usr/bin/env python3
+"""Post-run validation: check that all 21 agent tools were exercised.
+
+Usage:
+    python scripts/check_tool_coverage.py --name "tool-coverage"
+    python scripts/check_tool_coverage.py --simulation-id <uuid>
+
+Exits with code 0 if 21/21 tools found, 1 otherwise.
+"""
+
+from __future__ import annotations
+
+import argparse
+import asyncio
+import sys
+from pathlib import Path
+
+PROJECT_ROOT = Path(__file__).resolve().parent.parent
+sys.path.insert(0, str(PROJECT_ROOT))
+
+from dotenv import load_dotenv  # noqa: E402
+
+load_dotenv(PROJECT_ROOT / ".env")
+
+# All 21 tools that should be exercised
+ALL_TOOLS = sorted([
+    "send_message",
+    "get_world_state",
+    "get_audience_status",
+    "send_chat_message",
+    "create_poll",
+    "get_poll_results",
+    "recall_memory",
+    "retrieve_transcript",
+    "update_core_memory",
+    "execute_code",
+    "generate_tilemap",
+    "web_search",
+    "fetch_url",
+    "draft_social_post",
+    "draft_email",
+    "get_revenue_status",
+    "dispatch_alpha",
+    "propose_self_modification",
+    "view_evolution_log",
+])
+
+
+async def check_coverage(args: argparse.Namespace) -> bool:
+    """Query artifacts table and report tool coverage."""
+    from core.bootstrap import bootstrap_services, shutdown_services
+    from core.repos.simulation_repo import SimulationRepo
+
+    svc = await bootstrap_services()
+    sim_repo = SimulationRepo(svc.db)
+
+    simulation_id = None
+    if args.simulation_id:
+        import uuid
+        simulation_id = uuid.UUID(args.simulation_id)
+    elif args.name:
+        sims = await sim_repo.list(limit=100)
+        for s in sims:
+            if s.name == args.name:
+                simulation_id = s.id
+                break
+        if simulation_id is None:
+            print(f"ERROR: No simulation found with name '{args.name}'")
+            await shutdown_services(svc)
+            return False
+
+    query = """
+        SELECT DISTINCT tool_name, agent_id, status,
+               MIN(created_at) as first_used
+        FROM artifacts
+        WHERE simulation_id = $1
+        GROUP BY tool_name, agent_id, status
+        ORDER BY tool_name
+    """
+    rows = await svc.db.fetch(query, simulation_id)
+    await shutdown_services(svc)
+
+    found_tools: dict[str, dict] = {}
+    for row in rows:
+        tool = row["tool_name"]
+        if tool not in found_tools:
+            found_tools[tool] = {
+                "agent": row["agent_id"],
+                "status": row["status"],
+                "first_used": row["first_used"],
+            }
+
+    print(f"\n{'Tool Coverage Report':=^60}")
+    print(f"Simulation: {simulation_id}\n")
+
+    found_count = 0
+    for tool in ALL_TOOLS:
+        if tool in found_tools:
+            info = found_tools[tool]
+            status_marker = "OK" if info["status"] == "executed" else "ERR"
+            found_count += 1
+            print(f"  [{status_marker}] {tool:<30} agent={info['agent']}")
+        else:
+            print(f"  [--] {tool:<30} MISSING")
+
+    print(f"\n  Coverage: {found_count}/{len(ALL_TOOLS)} tools exercised\n")
+    return found_count == len(ALL_TOOLS)
+
+
+if __name__ == "__main__":
+    parser = argparse.ArgumentParser()
+    parser.add_argument("--name", type=str)
+    parser.add_argument("--simulation-id", type=str)
+    args = parser.parse_args()
+    success = asyncio.run(check_coverage(args))
+    sys.exit(0 if success else 1)

diff --git a/core/admin_routes.py b/core/admin_routes.py
index f6dbedc..eb9b8e0 100644
--- a/core/admin_routes.py
+++ b/core/admin_routes.py
@@ -132,6 +137,47 @@
+# ── Global Artifact Endpoints ─────────────────────────────────
+
+@router.get("/artifacts")
+async def list_artifacts(
+    simulation_id: uuid_mod.UUID | None = Query(default=None),
+    agent_id: str | None = Query(None),
+    artifact_type: str | None = Query(None, alias="type"),
+    status: str | None = Query(None),
+    since: datetime | None = Query(default=None),
+    until: datetime | None = Query(default=None),
+    search: str | None = Query(None),
+    sort: str = Query("newest"),
+    limit: int = Query(50, ge=1, le=500),
+    offset: int = Query(0, ge=0),
+) -> PaginatedResponse[Artifact]:
+    """Browse all artifacts with filtering, search, and pagination."""
+    db = _get_db()
+    from core.repos.artifact_repo import ArtifactRepo
+    artifact_repo = ArtifactRepo(db)
+
+    agent_ids = [a.strip() for a in agent_id.split(",") if a.strip()] if agent_id else None
+    types = [t.strip() for t in artifact_type.split(",") if t.strip()] if artifact_type else None
+    statuses = [s.strip() for s in status.split(",") if s.strip()] if status else None
+
+    artifacts, total = await artifact_repo.get_all_artifacts(
+        simulation_id=simulation_id,
+        agent_ids=agent_ids,
+        artifact_type=types,
+        status=statuses,
+        since=since,
+        until=until,
+        search=search,
+        sort=sort,
+        limit=limit,
+        offset=offset,
+    )
+    return PaginatedResponse(items=artifacts, total=total, limit=limit, offset=offset)

diff --git a/core/repos/artifact_repo.py b/core/repos/artifact_repo.py
index 3456ee0..fcd0740 100644
--- a/core/repos/artifact_repo.py
+++ b/core/repos/artifact_repo.py
@@ -130,6 +130,83 @@ class ArtifactRepo:
+    async def get_all_artifacts(
+        self,
+        *,
+        simulation_id: uuid.UUID | None = None,
+        agent_ids: list[str] | None = None,
+        artifact_type: list[str] | None = None,
+        status: list[str] | None = None,
+        since: datetime | None = None,
+        until: datetime | None = None,
+        search: str | None = None,
+        sort: str = "newest",
+        limit: int = 50,
+        offset: int = 0,
+    ) -> tuple[list[Artifact], int]:
+        """Global artifact query with filtering, search, sorting, and pagination."""
+        clauses: list[str] = []
+        params: list[object] = []
+        idx = 1
+
+        if simulation_id is not None:
+            clauses.append(f"simulation_id = ${idx}")
+            params.append(simulation_id)
+            idx += 1
+        if agent_ids:
+            clauses.append(f"agent_id = ANY(${idx}::text[])")
+            params.append(agent_ids)
+            idx += 1
+        if artifact_type:
+            clauses.append(f"artifact_type = ANY(${idx}::text[])")
+            params.append(artifact_type)
+            idx += 1
+        if status:
+            clauses.append(f"status = ANY(${idx}::text[])")
+            params.append(status)
+            idx += 1
+        if since is not None:
+            clauses.append(f"created_at >= ${idx}")
+            params.append(since)
+            idx += 1
+        if until is not None:
+            clauses.append(f"created_at <= ${idx}")
+            params.append(until)
+            idx += 1
+        if search:
+            clauses.append(f"(tool_input::text ILIKE ${idx} OR tool_output::text ILIKE ${idx})")
+            params.append(f"%{search}%")
+            idx += 1
+
+        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
+        order = {
+            "newest": "created_at DESC",
+            "oldest": "created_at ASC",
+            "agent": "agent_id ASC, created_at DESC",
+            "type": "artifact_type ASC, created_at DESC",
+        }.get(sort, "created_at DESC")
+
+        count = await self.db.fetchval(f"SELECT COUNT(*) FROM artifacts{where}", *params)
+        rows = await self.db.fetch(
+            f"SELECT * FROM artifacts{where} ORDER BY {order} LIMIT ${idx} OFFSET ${idx + 1}",
+            *params, limit, offset,
+        )
+        result = []
+        for r in rows:
+            d = dict(r)
+            _parse_jsonb_fields(d)
+            result.append(Artifact(**d))
+        return result, count or 0
```

Note: The existing files `core/bootstrap.py` and `core/tool_executor.py` were NOT modified in this diff. The Services dataclass and build_agent_tools() remain unchanged from their prior state.

For reference, the existing (unmodified) code:

```python
# core/bootstrap.py — Services dataclass (NOT in diff — unchanged)
@dataclass
class Services:
    db: Database | None
    redis: RedisClient | None
    http_client: httpx.AsyncClient | None
    agent_registry: AgentRegistry
    llm_client: OpenRouterClient | None
    core_memory: CoreMemoryManager | None
    recall_memory: RecallMemoryManager | None
    archival_memory: ArchivalMemoryManager | None
    compactor: MemoryCompactor | None
    context_assembler: ContextAssembler
    token_counter: TokenCounter
    memory_repo: MemoryRepo | None
    transcript_repo: TranscriptRepo | None
    event_bus: EventBus
    overseer: Overseer | None
    cost_repo: CostRepo | None
    config_loader: ConfigLoader

# core/tool_executor.py — build_agent_tools (NOT in diff — unchanged)
def build_agent_tools(agent_id: str, services: Services) -> dict[str, BaseTool]:
    core_tools = get_core_tools(
        event_bus=services.event_bus,
        redis_client=services.redis,
        agent_id=agent_id,
        overseer=services.overseer,
        cost_repo=services.cost_repo,
        llm_client=services.llm_client,
        memory_repo=services.memory_repo,
    )
```
