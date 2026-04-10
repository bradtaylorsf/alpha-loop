# Eval Cases

Step-level and end-to-end eval cases for the Alpha Loop pipeline.

> **New to evals?** Read the [Comprehensive Eval Guide](./GUIDE.md) for tutorials, use cases, and how-tos.

## Directory Structure

```
.alpha-loop/evals/
├── cases/
│   ├── e2e/                    # Full pipeline eval cases
│   │   └── {case-name}/
│   └── step/                   # Step-level eval cases
│       ├── plan/               # Plan step evals
│       ├── implement/          # Implement step evals
│       ├── test/               # Test step evals
│       ├── review/             # Review step evals
│       ├── learn/              # Learning extraction evals
│       ├── skill/              # Skill trigger/quality evals
│       └── test-fix/           # Test-fix loop evals
├── scores.jsonl                # Score history (append-only)
└── README.md                   # This file
```

## Adding a New Step-Level Eval Case

1. Create a directory under `cases/step/{step-name}/{case-name}/`
2. Add three files:

### metadata.yaml

```yaml
id: my-case-name          # Must match directory name
description: "What this case tests"
tags:
  - category
  - subcategory
source: manual             # or 'auto-captured', 'swe-bench'
```

### checks.yaml

```yaml
type: step
step: review               # plan, implement, test, review, verify, learn, skill, test-fix
eval_method: llm-judge     # llm-judge, keyword, execution
status: ready              # ready or needs-annotation
checks:
  - type: llm_judge
    model: claude-haiku-4-5
    rubric: |
      Score 1-5 based on:
      5 = Perfect match
      1 = Complete miss
    min_score: 4
  - type: keyword_present
    keywords:
      - expected-term
  - type: contains_any      # Pass if ANY value found (skill-creator compat)
    values:
      - option-a
      - option-b
  - type: not_contains       # Fail if ANY forbidden value found
    values:
      - forbidden-term
```

### input.md

Raw input text for the step eval. This is what gets fed to the agent.
For review evals, this should be a git diff. For learn evals, a run trace.

## Check Types

| Type | Description | Use Case |
|------|-------------|----------|
| `test_pass` | Runs test suite | E2E |
| `file_exists` | Verifies file exists | E2E |
| `grep` | Regex pattern in file | E2E |
| `http` | HTTP endpoint check | E2E |
| `diff_size` | Diff scope limits | E2E |
| `keyword_present` | ALL keywords must appear | Step |
| `keyword_absent` | NO keywords may appear | Step |
| `contains_any` | ANY value must appear | Step (skill-creator compat) |
| `not_contains` | NO values may appear | Step (skill-creator compat) |
| `llm_judge` | LLM rubric evaluation | Both |

## Skill-Creator Format Bridge

Skill evals can be written in either AlphaLoop format (checks.yaml) or
skill-creator format (evals.json). Convert between them:

```bash
# AlphaLoop → skill-creator
alpha-loop eval convert --direction to-skill

# skill-creator → AlphaLoop
alpha-loop eval convert --direction from-skill --input path/to/evals.json
```

### skill-creator evals.json format

```json
{
  "skill_name": "code-review",
  "evals": [
    {
      "id": 1,
      "prompt": "Review this PR with SQL injection",
      "expected_output": "Should identify SQL injection",
      "assertions": [
        { "type": "contains_any", "values": ["SQL injection", "parameterized"] },
        { "type": "not_contains", "values": ["LGTM", "looks good"] }
      ],
      "files": []
    }
  ]
}
```

## Running Evals

```bash
# Run all step-level evals
alpha-loop eval --suite step

# Run only review evals
alpha-loop eval --suite step --step review

# Run a single case
alpha-loop eval --case 001-sql-injection

# Run with verbose output
alpha-loop eval --suite step --verbose

# View scores
alpha-loop eval scores

# Compare runs
alpha-loop eval compare 1 2
```

## LLM Judge Model

Step-level evals use `claude-haiku-4-5` by default for LLM judge checks.
Override with the `evalModel` config option in `.alpha-loop.yaml`.
