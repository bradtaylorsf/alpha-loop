# Contributing to Alpha Loop

## Contributing Eval Cases

The eval system helps catch wiring failures and improve prompt quality. When you discover patterns that alpha-loop's default prompts should have caught, here's how to contribute them back.

### Quick Start

```bash
# Export an existing eval case from your project (anonymizes by default)
alpha-loop eval export 006-missing-di-injection

# Review the output in .alpha-loop-contrib/
# Then open a PR to the alpha-loop repo
alpha-loop eval export 006-missing-di-injection --pr
```

### Creating an Eval Case from a Failure

1. **Capture the failure** — When your project hits a wiring issue the pipeline missed:
   ```bash
   alpha-loop eval capture --quality
   ```
   This walks you through annotating what went wrong and which pipeline step should have caught it.

2. **Export for contribution** — Anonymize and package the case:
   ```bash
   alpha-loop eval export <case-id> --anonymize
   ```
   This creates `.alpha-loop-contrib/` with:
   - The eval case files (metadata.yaml, input.md, checks.yaml)
   - `PROMPT_CHANGES.md` documenting your local prompt modifications (if any)

3. **Review the output** — Check that project-specific details have been removed:
   - File paths should be generic (no usernames, project names)
   - Class/function names should be generic or representative of the pattern
   - The structural wiring failure pattern should be preserved

4. **Submit a PR** — Copy the exported case to `templates/evals/cases/` in your fork:
   ```
   templates/evals/cases/step/review/<your-case-id>/
     metadata.yaml
     input.md
     checks.yaml
   ```

### What Makes a Good Eval Case

- **Pattern-focused**: Tests a specific wiring failure type (missing DI, route shadowing, etc.)
- **Minimal**: Includes only the code needed to demonstrate the pattern
- **Generic**: Uses example names, not project-specific identifiers
- **Well-rubric'd**: The `checks.yaml` clearly defines what the review should catch
- **Reproducible**: Another user should get similar results running the case

### Distribution Eval Suite

Alpha-loop ships with common wiring failure patterns in `templates/evals/`:

| Case | Pattern |
|------|---------|
| 006-missing-di-injection | Service created but never passed to consumer |
| 007-silent-none-guard | Optional param with None guard hides missing injection |
| 008-route-shadowing | Static routes registered after parameterized routes |
| 009-unthreaded-dependency | Data consumer reads from a source nothing writes to |
| 010-fabricated-metrics | Estimated values displayed as real metrics |

New projects get these evals via `alpha-loop init`. Run `alpha-loop eval --suite step` to test your prompts against them.

### Including Prompt Fixes

If you've improved your local prompts to catch the pattern:

1. The export command generates `PROMPT_CHANGES.md` showing your modifications
2. Include this in your PR so maintainers can evaluate the prompt improvement
3. If the fix belongs in the distribution prompts (`templates/agents/`), include that change too

### Eval Case Format

Each case is a directory under `templates/evals/cases/step/<step>/` containing:

- **metadata.yaml** — Case ID, description, type, step, tags, source
- **input.md** — The diff or code the agent reviews (the "frozen" input)
- **checks.yaml** — LLM judge rubric defining what the review should catch
