# Detection Patterns

Per-category detection guidance. Each section gives language-agnostic commands first (ripgrep, git), then notes where language-specific tools add real value. Run the commands from the repo root.

All examples assume `rg` (ripgrep) is available. Pipe through `head -50` liberally — you want signal, not a wall of output.

## Universal exclusions

Apply these as a baseline. Most rot detection should ignore:

```
--glob '!node_modules/**' \
--glob '!.git/**' \
--glob '!dist/**' \
--glob '!build/**' \
--glob '!target/**' \
--glob '!.next/**' \
--glob '!__generated__/**' \
--glob '!vendor/**' \
--glob '!*.min.js' \
--glob '!*.map' \
--glob '!*.lock' \
--glob '!coverage/**'
```

Set this once as a shell variable or `.ignore` file. The patterns below assume it.

---

## 1. Naming inconsistency

The high-value finding: same concept spelled multiple ways. An agent looking at `userId` in one file and `user_id` in another will pick whichever it saw last.

### Detect mixed casing for the same root concept

For each suspected identifier root, check all common casings:

```bash
# Example: is "userId" stable across the repo?
rg -i --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs,java,rb,php}' -tcode \
   '\b(userId|user_id|userid|UserID|user-id)\b' \
   --count-matches | sort -t: -k2 -rn | head -20
```

If multiple casings appear with non-trivial counts in the same module/package, that's a finding. Heuristic: 80/20 split across a module = inconsistency worth flagging; 99/1 is usually just a typo to fix.

Concepts that commonly fragment — check each:

- `userId / user_id / uid`
- `clientId / client_id`
- `apiKey / api_key / API_KEY` (constant casing is OK)
- `firstName / first_name / fname`
- `createdAt / created_at / createTime / creation_date`
- `isActive / active / is_active / enabled`
- `email / emailAddress / email_address`

### Detect violations of stated conventions

If the repo has a `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, a `STYLE.md`, or a section in `CONTRIBUTING.md` that states naming rules, grep for violations of those rules. Stated convention + observed violation = high-severity finding (these are explicitly meant to guide agents).

### Detect inconsistent file naming

```bash
# Mixed file naming conventions in the same directory
git ls-files | awk -F/ '{print $1}' | sort -u | while read dir; do
  test -d "$dir" || continue
  ls "$dir" 2>/dev/null | grep -E '\.(ts|js|tsx|jsx|py|go)$' | \
    awk -F. '{print $1}' | awk '
      /[a-z][A-Z]/ {camel++}
      /_/ {snake++}
      /-/ {kebab++}
      END {if ((camel>0)+(snake>0)+(kebab>0) > 1) print "'$dir': camel="camel" snake="snake" kebab="kebab}'
done
```

Pattern: one directory using a mix of `userProfile.ts`, `user_settings.ts`, `user-preferences.ts` is rot. One convention per directory is the floor.

---

## 2. Dead/orphaned code & old implementations

Highest-leverage category for agent confusion. An unmarked `auth.old.ts` next to `auth.ts` will get pattern-matched.

### Detect by filename markers

```bash
rg --files | rg -i '(\.old\.|\.bak\.|\.backup\.|_old\.|_bak\.|_v[0-9]+\.|_legacy\.|_deprecated\.|\.orig\.|\.copy\.|-copy\.| copy\.|\.draft\.)'
```

Any hit here is a finding. Severity depends on:
- Is it referenced anywhere? `rg "from.*<filename>"` / `rg "import.*<filename>"` — if zero refs, high severity (just delete it)
- Is the sibling file present? `auth.old.ts` with no `auth.ts` is even more confusing

### Detect "v2" / numbered duplicates

```bash
# Files with version suffixes that aren't in a versioning system
rg --files | grep -E '(V2|V3|_v2|_v3|2\.|New|Updated)\.(ts|tsx|js|py|go)$'
```

Cross-reference with the non-suffixed version. If both exist and both are imported, that's a structural finding.

### Detect orphaned files (no imports)

Language-agnostic-ish — won't catch dynamic imports but catches most:

```bash
# For each source file, check if anything imports its basename
for f in $(rg --files -tts -tjs -tpy); do
  base=$(basename "$f" | sed 's/\.[^.]*$//')
  # Skip entry-pointy names
  case "$base" in index|main|__init__|app|server|cli) continue ;; esac
  count=$(rg -l "['\"\`/].*${base}['\"\`/.]" --glob "!${f}" 2>/dev/null | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "ORPHAN: $f"
  fi
done | head -50
```

Note: false positives on tests, scripts, and migration files. Cross-check before flagging. Look at git log on the file — if it hasn't been touched in 12+ months and has no importers, it's almost certainly dead.

### Detect commented-out code blocks

```bash
# Large commented-out blocks (5+ consecutive comment lines that look like code)
rg -tts -tjs -tpy -U '(//[^\n]*\n){5,}|(#[^\n]*\n){5,}' --multiline-dotall -l
```

Then sample a few to verify they look like commented code (not docs). Files with multiple such blocks are findings.

### Detect TODO/FIXME aging

```bash
# TODOs older than 1 year — agents treat these as live signal
rg -n 'TODO|FIXME|XXX|HACK' | while IFS=: read file line rest; do
  blame=$(git blame -L "$line,$line" --date=short "$file" 2>/dev/null | head -1)
  echo "$blame  ::  $file:$line"
done | sort | head -20
```

Old TODOs that reference removed code or completed work are stale-doc findings too.

---

## 3. Inconsistent patterns

Look for *two valid ways of doing the same thing* coexisting in the same codebase. The pattern itself is fine; the inconsistency is the rot.

### Async patterns (JS/TS)

```bash
# Promise.then vs async/await — count each
rg -tts -tjs '\.then\s*\(' --count-matches | awk -F: '{s+=$2} END {print "then() calls:", s}'
rg -tts -tjs '\bawait\s+' --count-matches | awk -F: '{s+=$2} END {print "await calls:", s}'
```

If both are non-trivial *and* they appear in the same modules, finding. If `.then` is concentrated in 2 legacy files, those files are dead-code candidates.

### Error handling

```bash
# JS/TS: try/catch vs Result-types vs .catch
rg -tts -tjs '\btry\s*\{' --count-matches
rg -tts -tjs '\.catch\s*\(' --count-matches
rg -tts -tjs '\b(Result|Either|Ok|Err)\b' --count-matches

# Python: try/except vs result objects vs explicit error returns
rg -tpy 'except\s+\w' --count-matches
rg -tpy 'return\s+(None|False|-1)\s*(#.*error|#.*fail)' --count-matches

# Go: if err != nil vs panic vs errors.Wrap variants
rg -tgo 'if\s+err\s*!=\s*nil' --count-matches
rg -tgo 'errors\.(Wrap|WithMessage|Errorf)' --count-matches
rg -tgo 'fmt\.Errorf' --count-matches
```

Flag when two distinct error-handling philosophies coexist with no documented boundary between them.

### Logging

```bash
# Multiple loggers in one codebase
rg -tts -tjs 'console\.(log|error|warn|info)' --count-matches | awk -F: '{s+=$2} END {print "console:", s}'
rg -tts -tjs '(winston|pino|bunyan|log4js|loglevel)' -l | head -5
rg -tpy 'print\(' --count-matches | awk -F: '{s+=$2} END {print "print:", s}'
rg -tpy '(logging|loguru|structlog)\.' -l | head -5
```

`console.log` + a real logger coexisting = finding (agents will copy whichever they saw first).

### Config access

```bash
# process.env scattered vs centralized config module
rg -tts -tjs 'process\.env\.' -l | wc -l
rg -tts -tjs '(getConfig|config\.|loadConfig)' -l | wc -l

rg -tpy 'os\.environ' -l | wc -l
rg -tpy '(settings\.|get_config|Config\()' -l | wc -l
```

If env vars are read directly in 20 files *and* there's a config module, that's a finding (decide which is canonical).

### Imports / module style

```bash
# CommonJS require() and ESM import in the same package
rg -tjs '^\s*const\s+\w+\s*=\s*require\(' --count-matches | head -5
rg -tjs '^\s*import\s+' --count-matches | head -5
```

---

## 4. Misspellings & typos

Identifier typos are the dangerous kind — they propagate. Comment typos are usually low-severity.

### Run codespell (if available, install if not)

```bash
codespell --skip='./node_modules,./.git,./dist,./build,./*.lock' \
          --ignore-words-list='nd,te,fo,wee,parsable' \
          --count
```

If `codespell` isn't installed, suggest installing it (`pip install codespell`) — it's the right tool. If the user doesn't want to install, fall back to:

```bash
# Common typo patterns in identifiers
rg -i '\b(recieve|recieved|seperat|seperate|occurence|occured|untill|begining|definately|enviroment|sucess|sucessful|paramater|paremeter|wierd|adress|accomodate|alot|alreddy|allways|arguement|calender|cancelation|catagory|comming|commited|completly|concious|congradul|consious|cooly|defenately|definatly|dependant|desireable|develope|developement|dilemna|dissapear|embarass|enviornment|excede|excellance|existance|familar|fourty|freind|grammer|guage|happend|heigth|independant|inteligence|judgement|knowlege|labratory|lenght|liason|libary|liscense|maintainance|managment|millenium|mispell|nieghbor|noticable|occassion|occured|paralel|parliment|particularily|peice|perminent|perseverence|pertinant|posession|preceeding|publically|pursuasive|recieved|reciept|recomend|refered|relevent|reminisent|rythym|scary|seperated|similiar|sincerly|speach|succesful|supercede|tendancy|thier|threshhold|tommorow|truely|tyranny|underate|untill|usefull|wether)\b' \
   --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs,java,rb,php,md}' -tcode \
   | head -30
```

### Detect typo-in-identifier (high severity)

Whatever the typo, if it appears in an exported symbol, it's high-severity — every caller has now inherited it:

```bash
# Take any typo hits from above, check if they appear in declarations
rg '(export\s+(function|const|class|interface|type)|def |func |class )\s+\w*<typo>\w*' -tcode
```

---

## 5. Duplicate concepts/utilities

Two functions doing the same thing under different names. Agents will create a third.

### Detect by canonical utility names

```bash
# Common utility function names that often duplicate
for name in formatDate parseDate toDate dateToString \
            slugify toSlug stringToSlug \
            debounce throttle \
            deepClone clone copyObject \
            isEmail validateEmail checkEmail \
            isEmpty isBlank empty \
            httpGet fetchJson apiCall request \
            sleep delay wait \
            uuid generateId makeId randomId; do
  count=$(rg -tcode -c "(function|const|def|func)\s+${name}\b" 2>/dev/null | wc -l)
  [ "$count" -gt 1 ] && echo "DUPLICATE CANDIDATE: $name ($count files define it)"
done
```

For each hit, manually verify: are these actually doing the same thing, or are they domain-specific (`formatDate` for invoices vs `formatDate` for logs is fine if names disambiguate by module)?

### Detect by signature similarity

This is harder to do mechanically. Useful heuristics:

```bash
# Multiple files with very similar function signatures
rg -tcode --no-line-number -o '(function|def|func)\s+\w+\s*\([^)]*\)' | \
  sort | uniq -c | sort -rn | head -20
```

If two files define `function formatCurrency(amount, currency)` with the same signature, look at both bodies. If they're 80%+ equivalent, finding.

### Detect parallel directory structures

```bash
# Suspicious: utils/ and helpers/ and lib/ all in same project
ls -d */ 2>/dev/null | grep -iE '^(utils?|helpers?|lib|common|shared|misc|tools)/'
find . -type d -name 'utils' -o -name 'helpers' -o -name 'lib' 2>/dev/null | \
  grep -v node_modules | head
```

Multiple "junk drawer" directories = high chance of duplicated utilities across them.

---

## 6. Stale documentation

README and inline docs that describe code that no longer exists or behaves differently. Agents trust docs.

### Detect README references to removed code

```bash
# Pull code-fenced snippets and identifier references from README
rg -o '`[a-zA-Z_][a-zA-Z0-9_.]+`' README.md docs/ 2>/dev/null | \
  awk -F: '{print $NF}' | tr -d '`' | sort -u > /tmp/readme_refs.txt

# For each, check if it exists in code
while read ref; do
  # Strip method calls / property accesses for the search
  name=$(echo "$ref" | sed 's/[().].*//')
  [ -z "$name" ] && continue
  rg -tcode -q "\b${name}\b" || echo "STALE REF: $ref"
done < /tmp/readme_refs.txt | head -20
```

False positives on common words — filter for things that look like identifiers (camelCase, snake_case, PascalCase). High-value when the README's "Quick Start" snippet imports a function that doesn't exist anymore.

### Detect docs older than the code they describe

```bash
# For each docs file, find code it references and compare mtimes
for doc in README.md $(find docs -name '*.md' 2>/dev/null); do
  doc_age=$(git log -1 --format=%ct -- "$doc" 2>/dev/null)
  [ -z "$doc_age" ] && continue
  newest_code=$(find src lib app -type f \( -name '*.ts' -o -name '*.py' -o -name '*.go' \) -printf '%T@\n' 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
  [ -z "$newest_code" ] && continue
  if [ "$newest_code" -gt "$doc_age" ]; then
    diff_days=$(( (newest_code - doc_age) / 86400 ))
    if [ "$diff_days" -gt 180 ]; then
      echo "STALE: $doc ($diff_days days behind newest code)"
    fi
  fi
done
```

This is a heuristic — old docs can still be accurate. Use it as a signal to read the doc, not as a finding on its own.

### Detect inline comments that contradict the code

This needs reading. Sample comments near function definitions and check the function still does what the comment claims:

```bash
# Pull docstring/jsdoc blocks
rg -tts -tjs -U '/\*\*[\s\S]*?\*/' --multiline -A 1
rg -tpy -U '"""[\s\S]*?"""' --multiline -A 1
```

Sample 10-20 and verify against the function body. Look for:
- Parameter names that don't match the signature
- Return types that contradict the actual return
- "Returns null if X" claims where the code returns undefined / raises
- References to removed parameters

### Detect broken internal links

```bash
rg -o '\]\(\.?/?[^)]+\.(md|py|ts|js)[^)]*\)' --no-line-number docs/ README.md 2>/dev/null | \
  while IFS=: read file ref; do
    path=$(echo "$ref" | sed -E 's/.*\(([^)]+)\).*/\1/' | sed 's/#.*//')
    test -f "$path" || test -f "$(dirname "$file")/$path" || echo "BROKEN: $file -> $path"
  done | head -20
```

---

## Cross-cutting tips

- **Always look at git blame** on a suspicious file before flagging. A file last touched 3 years ago is different from one touched last week.
- **Imports tell the truth.** If a file claims to be "the new way" but only 2 places import it and 50 import the "old way," the names lie.
- **Run quick checks first.** Skim a `find . -name "*.old.*"` and a typo scan before doing the deep analysis — it sets the tone for what kind of repo you're in.
- **Check `git log --diff-filter=D --summary | head -50`** for recently deleted files whose names might still appear in docs or comments.
