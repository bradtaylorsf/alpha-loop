# Session Summary: session/epic-405-epic-triage-correctness-triage-reports-closes-it-did-not-perform-and-its-preview-does-not-predict-apply

## Overview
- All three issues succeeded without retries, improving triage correctness across close-reason mapping, verified mutation outcomes, and deterministic dry-run/apply behavior.

## Recurring Patterns
- Normalize and validate data at adapter and artifact boundaries.

## Recurring Anti-Patterns
- Allowing external-tool vocabulary or invalid action/category combinations to leak through without boundary validation.

## Recommendations
- Update `api-contracts` to require explicit mappings when REST APIs, CLIs, and domain models use different enum vocabularies.

## Metrics
| Metric | Value |
