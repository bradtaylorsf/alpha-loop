# Skill trigger regression: history queue command docs drift

You are in the review/learn stage for a completed Alpha Loop issue. Decide which skill should
fire and what concrete follow-up or patch should be proposed.

The implementation diff touched a CLI command handler but did not update command docs:

```diff
diff --git a/src/commands/history.ts b/src/commands/history.ts
index 1111111..2222222 100644
--- a/src/commands/history.ts
+++ b/src/commands/history.ts
@@
 export function historyCommand(session?: string, options: HistoryOptions = {}): void {
+  if (session?.startsWith('queue-')) {
+    showQueueManifest(session);
+    return;
+  }
   if (options.clean) {
     cleanHistory();
     return;
   }
```

The current CLI help now describes history as session and queue history:

```text
$ alpha-loop history --help
Usage: alpha-loop history [options] [session]
View session and queue history
```

But `CLAUDE.md` is stale:

```text
alpha-loop history       # View session history
alpha-loop history <name> --qa    # Show QA checklist for session
alpha-loop history --clean        # Remove old session data
```

And `README.md` is stale:

```markdown
| `alpha-loop history` | View session history |
| `alpha-loop history <name>` | View a specific session |
| `alpha-loop history <name> --qa` | Show QA checklist for session |
| `alpha-loop history --clean` | Remove old session data |
```

Expected review/learn behavior: this should not be treated as a code-only change. The agent
should invoke the documentation synchronization skill, compare CLI help text against both docs,
and propose adding the missing `alpha-loop history queue-<timestamp>` documentation.
