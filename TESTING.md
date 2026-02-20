# opencode-devtools Testing Procedures

## Prerequisites

- Bun runtime installed
- OpenCode with plugin support
- For full testing: Azure DevOps CLI (`az`), valid `.cloudpresser` PAT

## Setup

1. Clone repo, `bun install`
2. In consumer project (e.g. tensor/staging):
   - Add to `opencode.json`: `"plugins": ["<path-to>/opencode-devtools/src/index.ts"]`
   - Create `.devtools.jsonc` enabling desired tools (or run `bunx devtools init`)
3. Restart OpenCode to load plugin

## Testing Each Tool

### check-types

```
Call check-types tool with no args → should run yarn check-types
Call with compact=true → errors grouped by file
Call with compact=false → raw tsc output
Call with branchOnly=true → uses branchCommand/branchArgs
```

**Verify:** Exit code handling (0=pass, non-zero=errors parsed), TS error regex matching
for both formats: `file(line,col): error TSxxxx` and `file:line:col - error TSxxxx`

### run-tests

```
Call with no args → runs full test suite, aggregates results across packages
Call with package="some-package" → scopes to that package
Call with watch=true → spawns PTY session, returns session info
```

**Verify:** Lerna/Nx output aggregation (Tests: X passed, Test Suites: X passed),
failure extraction (FAIL lines + bullet blocks), Nx cache reporting

### lint

```
Call with no args → lints changed files only
Call with all=true → lints everything
Call with fix=true → auto-fixes
Call with staged=true → lints staged files
```

**Verify:** ESLint problem count parsing, flag composition

### dev-server_start

```
Call with server="nextjs" → starts Next.js on port 3000 (or next available)
Call with server="expo" → starts Expo on port 8081
Call again while running → returns existing session info (no duplicate)
Call with port=3001 → uses custom port
```

**Verify:** Port scanning, process-on-port killing, ready pattern detection with
timeout, PTY session creation, duplicate prevention via findByTitle

### server-logs

```
Call with server="nextjs" → reads Next.js PTY buffer
Call with server="next" → alias resolves to "nextjs"
Call with pattern="error" → regex-filtered output
Call with errorsOnly=true → error/warning lines only
Call with offset=50, lineCount=20 → pagination
```

**Verify:** Alias resolution, ANSI stripping (unless verbose=true), pagination math

### generate

```
Call with template="feature", name="my-feature" → scaffolds feature
Call with template="view", name="my-view", parent="my-feature" → scaffolds view under feature
```

**Verify:** Flag construction, output filtering for generated file paths

### create-pr

```
Call with no args → auto-detects everything, goes through interactive flow
Call with title="Test PR", body="Description" → pre-fills fields
Call with draft=true → creates draft PR
```

**Verify:** PTY prompt detection (accumulated buffer, not per-chunk), auto-answer
sequence (n, n, y), PR URL extraction, timeout handling (120s default)

### build-status

```
Call with no args → auto-detects org/project from git remote, fetches 3 runs
Call with branch="main" → filters by branch
Call with watch=true → spawns polling PTY session
```

**Verify:** Git remote parsing (SSH + HTTPS formats), az CLI invocation,
critical vs non-blocking run classification, watch loop interval

## Config Loading Test

```
1. No config file → all defaults applied, default tools enabled
2. Empty {} config → same as above (Zod defaults)
3. Partial config → merged with defaults
4. JSONC with comments + trailing commas → parsed correctly
5. Invalid config → Zod error logged, falls back to defaults
```

## Setup CLI Test

```
1. Run `bun src/cli.ts` from any directory
2. Verify TUI shows all 8 tools with labels and hints
3. Verify default selections match DEFAULT_TOOLS_ENABLED
4. Select a subset → verify .devtools.jsonc output:
   - Enabled tools have full defaults uncommented
   - Disabled tools are fully commented out
   - File is valid JSONC (parseable by strip-json-comments + JSON.parse)
5. Run again with existing config → verify it reads current selections as initial values
6. Verify overwrite confirmation prompt works
7. Load generated config via loadConfig() → verify Zod parses correctly
```

## Common Issues

- **Tools not loading after edit:** OpenCode caches plugins at startup. Must restart.
- **posix_spawn ENOENT:** `Bun.spawn` blocked in sandbox. Must use bun-pty Terminal.
- **PTY prompt splitting:** create-pr prompt text arrives in chunks across onData calls.
  Must accumulate buffer and match against full accumulated text.
- **Server alias mismatch:** Users type "next" but config key is "nextjs". Alias resolution
  handles this via prefix matching.
- **Nx cache in test output:** Only last project shows raw output. Aggregation logic sums
  all Tests:/Test Suites: lines across projects.
