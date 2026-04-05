# Issue #192: Timeline Reporter — memory and journal sections

## Summary

Add memory history, recall memory counts, and journal entry sections to the
timeline report. Each section loads data from the database for the current
simulation and formats it for the report.

## Acceptance Criteria

- [ ] Memory history section shows core memory changes for the simulation
- [ ] Recall memory section shows search counts per agent for the simulation
- [ ] Journal entries section shows reflection entries for the simulation
- [ ] Agent list is derived from agents participating in the simulation

## Diff to review

```diff
diff --git a/reporting/sections/__init__.py b/reporting/sections/__init__.py
new file mode 100644
--- /dev/null
+++ b/reporting/sections/__init__.py
@@ -0,0 +1,3 @@
+from .memory import build_memory_section
+from .journal import build_journal_section
+from .agents import build_agent_section

diff --git a/reporting/sections/memory.py b/reporting/sections/memory.py
new file mode 100644
--- /dev/null
+++ b/reporting/sections/memory.py
@@ -0,0 +1,78 @@
+"""Memory sections for timeline reports."""
+
+from __future__ import annotations
+
+import logging
+from typing import Any
+
+logger = logging.getLogger(__name__)
+
+
+async def build_memory_section(db, simulation_id) -> dict[str, Any]:
+    """Build the memory section of a timeline report."""
+    core_history = await _load_core_memory_history(db, simulation_id)
+    recall_counts = await _load_recall_memory_counts(db, simulation_id)
+    return {
+        "core_memory_changes": core_history,
+        "recall_memory_searches": recall_counts,
+    }
+
+
+async def _load_core_memory_history(db, simulation_id) -> list[dict]:
+    """Load core memory snapshot history for a simulation."""
+    rows = await db.fetch(
+        """
+        SELECT agent_id, section, content, updated_at
+        FROM core_memory_snapshots
+        ORDER BY updated_at DESC
+        LIMIT 500
+        """
+    )
+    return [
+        {
+            "agent_id": row["agent_id"],
+            "section": row["section"],
+            "content": row["content"][:200],
+            "updated_at": row["updated_at"].isoformat(),
+        }
+        for row in rows
+    ]
+
+
+async def _load_recall_memory_counts(db, simulation_id) -> list[dict]:
+    """Load recall memory search counts per agent for a simulation."""
+    rows = await db.fetch(
+        """
+        SELECT agent_id, COUNT(*) as search_count
+        FROM recall_memory
+        GROUP BY agent_id
+        ORDER BY search_count DESC
+        """
+    )
+    return [dict(row) for row in rows]


diff --git a/reporting/sections/journal.py b/reporting/sections/journal.py
new file mode 100644
--- /dev/null
+++ b/reporting/sections/journal.py
@@ -0,0 +1,42 @@
+"""Journal section for timeline reports."""
+
+from __future__ import annotations
+
+import logging
+from typing import Any
+
+logger = logging.getLogger(__name__)
+
+
+async def build_journal_section(db, simulation_id) -> dict[str, Any]:
+    """Build the journal section of a timeline report."""
+    entries = await _load_journal_entries(db, simulation_id)
+    return {"entries": entries, "total_count": len(entries)}
+
+
+async def _load_journal_entries(db, simulation_id) -> list[dict]:
+    """Load journal entries for a simulation."""
+    rows = await db.fetch(
+        """
+        SELECT agent_id, entry_type, content, created_at
+        FROM journal_entries
+        ORDER BY created_at DESC
+        LIMIT 200
+        """
+    )
+    return [
+        {
+            "agent_id": row["agent_id"],
+            "type": row["entry_type"],
+            "content": row["content"][:300],
+            "created_at": row["created_at"].isoformat(),
+        }
+        for row in rows
+    ]


diff --git a/reporting/sections/agents.py b/reporting/sections/agents.py
new file mode 100644
--- /dev/null
+++ b/reporting/sections/agents.py
@@ -0,0 +1,30 @@
+"""Agent section for timeline reports."""
+
+from __future__ import annotations
+
+import logging
+from typing import Any
+
+logger = logging.getLogger(__name__)
+
+
+async def build_agent_section(db, simulation_id) -> dict[str, Any]:
+    """Build the agent section showing participating agents."""
+    agent_ids = await _get_agent_ids(db, simulation_id)
+    return {"agents": agent_ids, "agent_count": len(agent_ids)}
+
+
+async def _get_agent_ids(db, simulation_id) -> list[str]:
+    """Get all agent IDs for a simulation."""
+    rows = await db.fetch(
+        """
+        SELECT DISTINCT agent_id
+        FROM agents
+        ORDER BY agent_id
+        """
+    )
+    return [row["agent_id"] for row in rows]
```

Note: Every helper function accepts `simulation_id` as a parameter. The `core_memory_snapshots`, `recall_memory`, `journal_entries`, and `agents` tables all have a `simulation_id` column. The database contains data from 12 different simulation runs.
