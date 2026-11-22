# Security Profiles

A security profile names one upstream technique catalog, the watched file Alpha Loop pins by commit SHA, and the local oracle commands that turn selected techniques into session-end checks. Alpha Loop does not vendor either upstream tree. The selector offers only techniques that have a local oracle. The session-end executor runs those commands once and writes a proof bound to the session git SHA.

Field reference for flags and config keys lives in the [Configuration Reference](../README.md#configuration-reference) and the Commands section of the [README](../README.md#commands). This guide states how to declare, override, and disable each profile.

## Application profile

Default source: [https://github.com/mitre/cti](https://github.com/mitre/cti).

Watched file: `enterprise-attack/enterprise-attack.json` (ref `master` unless overridden).

Surfaces this profile matches:

- `public-http`
- `credentials-at-rest`
- `command-execution`
- `cloud-control-plane`

Detection uses file signals under the project (and optional closed-set model surface JSON). A technique whose tactic matches a detected surface is a candidate only when `templates/security-profiles/oracles.json` binds that technique ID to a local command. A technique with no oracle is marked `no-local-check` and is not offered in the selector.

## Agent profile

Default source: [https://github.com/secure-agentic-framework/saf-mcp](https://github.com/secure-agentic-framework/saf-mcp).

Watched file: `research/framework-model.yml` (ref `main` unless overridden). Alpha Loop keeps the MCP-profile subset of that model (tool definitions, tool results, sampling, authorization, transports).

This profile is absent unless the selected agent's project MCP config names at least one server (for example Claude `.mcp.json`, Codex MCP tables, or OpenCode MCP config). A repository that never exposes MCP does not receive the agent technique list.

## Declare

Set both catalogs on in `.alpha-loop.yaml`. Missing profile keys use the defaults above. Both `enabled` defaults are `true`.

```yaml
security_checks: true
security_profiles:
  application:
    enabled: true
    url: https://github.com/mitre/cti
    ref: master
    watch:
      - enterprise-attack/enterprise-attack.json
  agent:
    enabled: true
    url: https://github.com/secure-agentic-framework/saf-mcp
    ref: main
    watch:
      - research/framework-model.yml
```

`alpha-loop init --sec-mile` or `alpha-loop run --sec-mile` opens the selector after context is written. The selector writes `.alpha-loop/security-plan.json` with the accepted watched-file SHA per profile URL and the selected checks. Issues created from that selection receive the `security-check` label and do not receive `ready`.

## Override

Replace `url`, `ref`, or `watch` for one profile. The other profile stays on its default when you leave its keys unset.

```yaml
security_checks: true
security_profiles:
  application:
    enabled: true
    url: https://github.com/example/my-attack-fork
    ref: main
    watch:
      - enterprise-attack/enterprise-attack.json
  # agent omitted → default secure-agentic-framework/saf-mcp URL, ref, and watch
```

The next `--sec-mile` run compares the saved pin in `.alpha-loop/security-plan.json` with the latest commit that touched each watch path. A difference is shown as added, removed, and changed technique IDs. The saved pin stays until you accept the new SHA. Accepting updates `catalogRevision` for new selections; it does not silently float with the remote tip.

## Disable

Three controls:

| Control | Effect |
|---------|--------|
| `security_checks: false` | Turns the selector and the session gate off for both profiles. |
| `security_profiles.application.enabled: false` or `security_profiles.agent.enabled: false` | Drops that one catalog and leaves the other. |
| `alpha-loop run --skip-sec` | Skips the session-end gate for one run and records `NOT_RUN` for every selected row. |

`--skip-tests` does not mark the product suite passed for this gate. The security executor still requires a passed product suite (or `--skip-sec`) before it classifies rows as `PASS` or `FAIL`.

## Proof limit

A row is `PASS` when that command exited with `passExit` on the session git SHA recorded in the proof file. A row is `FAIL` when the command is blocked, times out, or exits with a different code. A row is `NOT_RUN` when the product suite failed or `--skip-sec` was set.

`PASS` does not close the GitHub milestone. `PASS` does not establish SOC 2 or NIST compliance. The proof stores the git SHA, each technique's status, and the accepted catalog revision. It is a local oracle result for that build, not a compliance attestation.

## Newsletter demo

The newsletter signup demo lives under `examples/newsletter-signup/`. It is a Next.js email form with `POST /api/signup`, `GET /api/health`, and no public route that serves the stored address file. Alpha Loop is not the service under test. The demo proves the application profile against a running container and records the agent profile as not applicable when no MCP server is configured.

### One-time template image

The Dockerfile tags `newsletter-signup:template`. The end-to-end script builds that tag only when it is missing. A later validation run does not rebuild or retag it. A code fix for a later run is a commit on a new branch or fork of the demo repo. It does not change this image. A new image, if required later, gets a new tag.

### Demo repo and branch

Default repo name: `newsletter-signup-demo` under the authenticated `gh` user (override with `DEMO_REPO=owner/name`). The first successful run creates that GitHub repo from the template directory. Its default branch stays the unmodified template.

Each validation run copies onto a new branch `security-run/<timestamp>` (or `DEMO_FORK=1` to fork, then branch). Milestones, `security-check` issues, `.alpha-loop/security-plan.json`, and `security-profile-report.md` are written on that copy only. They are not created on the template default branch.

### Config and oracles

The copy’s `.alpha-loop.yaml` sets `security_checks: true` and leaves both profiles enabled at their default URLs. It does not set `security_profiles.agent.enabled: false`. The scan decides applicability. `templates/security-profiles/oracles.json` on the template binds only application checks: health returns 200, empty email is rejected, valid email is accepted, and the stored file is not fetched from a public path.

### Script

```bash
# From the Alpha Loop checkout (build dist first: pnpm build)
./examples/newsletter-signup/test-security-e2e.sh

# Optional
DEMO_REPO=myorg/newsletter-signup-demo ./examples/newsletter-signup/test-security-e2e.sh
DEMO_FORK=1 ./examples/newsletter-signup/test-security-e2e.sh
DRY_RUN=1 ./examples/newsletter-signup/test-security-e2e.sh   # report shape without live Docker/gh
```

Steps the script performs:

1. Build `newsletter-signup:template` only if missing.
2. `docker compose up -d` from that image; wait for `/api/health` 200.
3. Create the demo repo on first run when `gh` auth works; each run creates `security-run/<timestamp>` (or a fork when `DEMO_FORK=1`); clone that copy to a temp directory.
4. `alpha-loop init --sec-mile --yes` in the copy. Agent profile is `NOT_APPLICABLE` (no MCP).
5. Create milestones and `security-check` issues on the branch or fork only.
6. Run the security executor against the container from `newsletter-signup:template`.
7. Write `security-profile-report.md` on the copy.
8. `docker compose down`. The script does not remove `newsletter-signup:template`.

### Two-section report

`security-profile-report.md` records the template image ID, demo repo, and branch, then:

| Section | Source | Result |
|---------|--------|--------|
| Application | https://github.com/mitre/cti | `PASS` only when every selected oracle row is `PASS` |
| Agent | https://github.com/secure-agentic-framework/saf-mcp | `NOT_APPLICABLE` — no MCP server configured for the selected agent; milestone count 0 |
| Overall | — | `PASS` when application is `PASS` and agent is `NOT_APPLICABLE` |

An application `PASS` means those HTTP oracles exited with `passExit` against the template container for that run. It does not state that the form is immune to the ATT&CK tactic.
