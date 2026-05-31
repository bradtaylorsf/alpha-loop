# Web/App Verification Profile

`web_app` standardizes hosted Alpha Loop verification for websites and browser apps. It is provider-agnostic: Alpha Loop runs configured commands, captures browser artifacts, and passes preview/QA details through PRs, session history, and lifecycle events.

## Example

```yaml
web_app:
  setup_command: pnpm install
  build_command: pnpm build
  test_command: pnpm test
  dev_command: pnpm dev
  dev_url: http://localhost:4321
  smoke_test: pnpm build
  screenshots:
    - name: home-desktop
      url: /
      viewport: desktop
    - name: home-mobile
      url: /
      viewport: mobile
  preview:
    command: ./scripts/get-preview-url.sh
    required: false
```

## Behavior

- Empty commands fall back to package scripts where possible. Astro defaults to `http://localhost:4321`; Vite/React defaults to `http://localhost:5173`; Next and generic apps default to `http://localhost:3000`.
- `build_command`, `test_command`, `dev_command`, `smoke_test`, and `preview.command` are checked against `automation_policy.allowed_commands` before they run.
- Browser verification saves screenshots under `.alpha-loop/sessions/<session>/screenshots/issue-<N>/`.
- Browser results are recorded in `.alpha-loop/sessions/<session>/web-app-verification/issue-<N>.json`, including console errors and failed network requests.
- PR bodies include the preview URL, screenshot paths, browser result path, console/network summary, and human QA checklist.
- `qa.requested` events include the preview URL, screenshot paths, browser artifact metadata, and the exact checklist for human review.

## Preview URLs

Use `preview.url` when the URL is static. Use `preview.command` when another service creates previews. The command should print one `http` or `https` URL to stdout or stderr. Alpha Loop sets `ALPHA_LOOP_PR_URL` when a PR URL is available, so scripts can look up a provider-specific preview without Alpha Loop knowing the provider.

No native Vercel, Netlify, or custom host API is required.
