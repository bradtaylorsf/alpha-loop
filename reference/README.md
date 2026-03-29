# Reference Code

These files are battle-tested implementations from the alphaagent-coder project. They contain edge-case handling, retry logic, and patterns that were debugged over many iterations.

**Do NOT import these files directly.** Use them as reference when building or improving `src/engine/` modules.

## What's Here

| File | What to learn from it |
|------|----------------------|
| `cli-runner.reference.ts` | JSONL stream parsing, session ID management, OAuth token handling, process lifecycle, structured event emission |
| `github-client.reference.ts` | PR status tracking (merged/closed/draft/approved), branch validation before operations, rate limit error handling |
| `worktree-manager.reference.ts` | Retry logic with exponential backoff for git locks, file synchronization between worktrees, security validation for paths, cleanup on error |
| `logger.reference.ts` | Structured logging with component context, log levels |

## Key Patterns Worth Adopting

1. **Worktree retry logic**: Git locks can fail transiently. The reference implementation retries with exponential backoff.
2. **Rate limit detection**: GitHub returns 403 (not 429) for secondary rate limits. Check `retry-after` and `x-ratelimit-remaining` headers.
3. **CLI output parsing**: The JSONL stream format from `claude -p --output-format stream-json` provides token usage, cost, and session IDs.
4. **Error cleanup**: Always clean up worktrees on error -- no orphaned directories or branches.
