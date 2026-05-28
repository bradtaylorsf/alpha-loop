# Per-Language Tools

Read only the section(s) matching the repo's primary languages. The universal ripgrep-based detection in `detection-patterns.md` already covers most ground; this file is for cases where a language-specific tool is materially better.

Install tools opportunistically — if a tool isn't available, fall back to the universal patterns rather than blocking on installation. Mention to the user which tools would sharpen findings if they want to install them.

---

## TypeScript / JavaScript

### Dead code & unused exports

`knip` is the best tool here. It finds unused files, exports, and dependencies.

```bash
# One-shot, no config
npx -y knip --no-config-hints --reporter json 2>/dev/null | head -100
```

If `knip` complains about missing config, fall back to:

```bash
# ts-prune for unused exports (older but still useful)
npx -y ts-prune 2>/dev/null | head -30
```

### Unused dependencies

```bash
npx -y depcheck --json 2>/dev/null
```

### Type-level inconsistency

```bash
# Find interfaces/types defined more than once with the same name
rg -tts -o '(interface|type)\s+(\w+)' --no-line-number | \
  awk '{print $2}' | sort | uniq -c | sort -rn | awk '$1 > 1'
```

### Style inconsistency

```bash
# Mixed quote styles in same file
rg -tts -c "from\s+'" | head -5
rg -tts -c 'from\s+"' | head -5

# Mixed semicolons (if project doesn't enforce)
rg -tts -c ';\s*$' | head -5
```

---

## Python

### Dead code

```bash
# vulture finds unreachable code, unused imports, unused functions
pip install --quiet vulture 2>/dev/null
vulture . --min-confidence 80 --exclude '*/migrations/*,*/tests/*' 2>/dev/null | head -30
```

### Import inconsistency

```bash
# Mixed import styles for the same module
rg -tpy '^import\s+os' --count-matches | head -3
rg -tpy '^from\s+os\s+import' --count-matches | head -3

# Relative vs absolute imports for the same package
rg -tpy '^from\s+\.\.' -l | head -5
rg -tpy '^from\s+<package_name>' -l | head -5
```

### Typing inconsistency

```bash
# Functions with type hints vs without — in the same module
rg -tpy '^\s*def\s+\w+\([^)]*\)\s*->' -l | sort > /tmp/typed.txt
rg -tpy '^\s*def\s+\w+\([^)]*\)\s*:' -l | sort > /tmp/all_funcs.txt
comm -23 /tmp/all_funcs.txt /tmp/typed.txt | head
```

Files in both lists have mixed typing — partial typing is more confusing to agents than no typing at all.

### Pydantic / dataclass / TypedDict competing

```bash
rg -tpy 'BaseModel\b' -l | wc -l
rg -tpy '@dataclass' -l | wc -l
rg -tpy 'TypedDict' -l | wc -l
rg -tpy 'NamedTuple' -l | wc -l
```

Three or more in non-trivial counts → finding.

### Codespell with Python-tuned ignore list

```bash
codespell --skip='./venv,./.venv,./__pycache__,./build,./*.egg-info' \
          --ignore-words-list='nd,arange,iterm,assertin' \
          .
```

---

## Go

### Dead code

```bash
# staticcheck catches unused code
go install honnef.co/go/tools/cmd/staticcheck@latest 2>/dev/null
staticcheck ./... 2>&1 | grep -E 'U1000|U1001' | head -30
```

### Inconsistent error wrapping

```bash
rg -tgo 'fmt\.Errorf' --count-matches | awk -F: '{s+=$2} END {print "fmt.Errorf:", s}'
rg -tgo 'errors\.Wrap' --count-matches | awk -F: '{s+=$2} END {print "errors.Wrap:", s}'
rg -tgo 'errors\.New' --count-matches | awk -F: '{s+=$2} END {print "errors.New:", s}'
```

Three error-construction styles in one repo is rot.

### Inconsistent context handling

```bash
# Functions that take context.Context and ones that should but don't
rg -tgo 'func\s+\w+\([^)]*\)' --no-line-number | grep -v 'ctx\s\+context' | head
```

---

## Rust

```bash
# Dead code (compiler-driven, very reliable)
cargo check --message-format=json 2>/dev/null | \
  rg -o '"message":"[^"]*dead_code[^"]*"' | head

# Clippy for stylistic inconsistency
cargo clippy --message-format=short 2>&1 | head -30
```

---

## Java

```bash
# pmd / spotbugs are the right tools but heavy. Lightweight checks:
rg -tjava 'TODO|FIXME' -c | head
rg -tjava 'System\.out\.println' -l | head  # often left-behind debug
rg -tjava '@Deprecated' -l | head  # check if still used
```

---

## Ruby

```bash
# rubocop is overkill for rot detection. Quick scans:
rg -trb 'def\s+\w+' --count-matches | head
rg -trb 'TODO|FIXME|HACK' -c | head

# Mixed style: respond_to? vs duck typing checks
rg -trb 'respond_to\?' -l | wc -l
rg -trb 'is_a\?\|kind_of\?' -l | wc -l
```

---

## When a tool isn't installed

If a recommended tool isn't available, don't block. Options in order of preference:

1. Use the universal ripgrep patterns from `detection-patterns.md`
2. Note in the final report: "Tool X would sharpen findings in category Y. Install with `<cmd>` if interested."
3. Don't auto-install without asking. Tools like `vulture`, `knip`, `codespell` are usually fine to suggest; anything that touches the project's lockfile (`npm install`, `pip install` into project venv) should always be confirmed first.
