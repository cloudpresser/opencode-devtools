# opencode-devtools Architecture

## Overview

An OpenCode plugin that provides development tools (dev servers, type checking, linting, testing, PR creation, CI monitoring) as AI-callable tools. Each tool is self-contained and handles its responsibility end-to-end.

## File Structure

```
opencode-devtools/
├── index.ts                     # Root re-export: DevTools (default), TensorTools (deprecated)
├── package.json                 # name=opencode-devtools, main=src/index.ts
├── tsconfig.json                # ESNext/bundler, strict, types=bun-types
├── src/
│   ├── index.ts                 # Plugin entry: loadConfig → SessionManager → register tools
│   ├── config.ts                # SOURCE OF TRUTH: Zod schemas, DEFAULT_* constants, loadConfig()
│   ├── config-generator.ts      # JSONC config file generator (used by CLI)
│   ├── cli.ts                   # Interactive setup CLI (devtools init)
│   ├── session-manager.ts       # PTY session manager wrapping bun-pty Terminal
│   ├── utils.ts                 # stripAnsi, ERROR_FILTER, findAvailablePort, killProcessOnPort
│   └── tools/
│       ├── dev-server.ts        # Start Expo/Next.js servers via PTY
│       ├── server-logs.ts       # Read PTY buffer with filtering/pagination
│       ├── check-types.ts       # TypeScript type checking via Bun.$
│       ├── lint.ts              # ESLint via Bun.$
│       ├── generate.ts          # Scaffold code via Bun.$
│       ├── create-pr.ts         # Interactive PR creation via PTY (auto-answers prompts)
│       ├── run-tests.ts         # Test execution via Bun.$ (non-watch) or PTY (watch)
│       └── build-status.ts      # Azure DevOps CI monitoring via az CLI
```

## Core Concepts

### Plugin Architecture

- Registered in consumer's `opencode.json` as a plugin path
- Entry receives `{ directory, $ }` from OpenCode runtime
- Returns `{ tool: Record<string, ToolDefinition> }` — only enabled tools included
- Tools run in Bun runtime inside OpenCode's sandbox

### Execution Strategies

Two strategies based on tool needs:

1. **Bun.$ (awaited)** — For commands that run to completion:
   check-types, lint, generate, run-tests (non-watch), build-status (non-watch)

2. **bun-pty Terminal** — For background/interactive processes:
   dev-server (long-running), server-logs (reads PTY buffer), create-pr (interactive prompts),
   run-tests (watch mode), build-status (watch mode polling)

   Note: `Bun.spawn` is blocked in OpenCode sandbox (`posix_spawn` ENOENT). `bun-pty` uses
   native Unix PTY APIs (`forkpty`/`openpty`) which bypass this restriction.

### Session Manager

Singleton managing PTY sessions. 50k line rolling buffer per session.

- `spawn(opts)` — creates Terminal with onData/onExit handlers
- `findByTitle(title)` — locates running session by title substring
- `readBuffer(id, {offset, limit, pattern})` — paginated buffer read with regex filter
- `kill(id)` — terminates session

### Configuration System

Single source of truth: `src/config.ts`

**Schema hierarchy:**

- `DevToolsConfigSchema` (root)
  - `tools`: `ToolsEnabledSchema` — 8 boolean flags
  - `devServer`: `DevServerConfigSchema` — servers map, timeouts, port scanning
  - `serverLogs`: `ServerLogsConfigSchema` — defaultLineCount
  - `checkTypes`: `CheckTypesConfigSchema` — command, args, branchCommand
  - `lint`: `LintConfigSchema` — command, args, maxLines
  - `generate`: `GenerateConfigSchema` — command, args, templates list
  - `createPr`: `CreatePrConfigSchema` — command, args, timeout, urlPattern
  - `runTests`: `RunTestsConfigSchema` — command, args
  - `buildStatus`: `BuildStatusConfigSchema` — provider, command, topBuilds, watchInterval

**Config loading:** `.devtools.jsonc` or `.devtools.json` in project root.
Strips JSON comments + trailing commas, validates through Zod.
Falls back to all defaults when no file exists.

**Default tool enablement:**

- Enabled: dev-server, server-logs, check-types, lint, run-tests
- Disabled: generate, create-pr, build-status

**Metadata registry:** `TOOL_METADATA` in `src/config.ts` maps each tool key to a
human-readable label, hint, and config section key. Typed as
`Record<keyof typeof DEFAULT_TOOLS_ENABLED, ...>` so TypeScript enforces completeness
when new tools are added.

### Tool Signatures

Each tool factory: `create*Tool(config, ...) → [toolName, toolDefinition]`

| Tool         | Name               | Execution         | Key Args                                                     |
| ------------ | ------------------ | ----------------- | ------------------------------------------------------------ |
| Dev Server   | `dev-server_start` | PTY spawn         | server (enum), port?                                         |
| Server Logs  | `server-logs`      | PTY buffer read   | server, pattern?, offset?, lineCount?, verbose?, errorsOnly? |
| Check Types  | `check-types`      | Bun.$             | compact? (default true), branchOnly?                         |
| Lint         | `lint`             | Bun.$             | all?, staged?, fix?                                          |
| Generate     | `generate`         | Bun.$             | template (enum), name, parent?, isStreaming?                 |
| Create PR    | `create-pr`        | PTY (interactive) | title?, body?, draft?, targetBranch?, baseBranch?            |
| Run Tests    | `run-tests`        | Bun.$ / PTY watch | package?, watch?, coverage?                                  |
| Build Status | `build-status`     | Bun.$ / PTY watch | organization?, project?, branch?, watch?                     |

### Key Implementation Details

**dev-server**: Checks for existing running session first (returns info, avoids duplicates).
Scans for available port, kills conflicting processes. Polls for readiness using configurable
regex patterns (e.g. "Ready in" for Next.js, "Logs for your project" for Expo).

**create-pr**: Uses bun-pty directly (not SessionManager) because it's a one-shot interactive
process. Accumulates PTY output, detects 3 prompts via regex on accumulated stripped text:
edit title? → n, edit description? → n, create PR? → y. Extracts PR URL from output.

**run-tests**: Aggregates Lerna/Nx output across projects. Sums Tests/Test Suites counts.
On failure, extracts FAIL lines (with package paths) and failure detail blocks (lines starting
with the bullet character).

**build-status**: Auto-detects Azure DevOps org/project from git remote URL.
Supports both SSH (`ssh.dev.azure.com:v3/ORG/PROJECT`) and HTTPS (`dev.azure.com/ORG/PROJECT`).
Fetches `topBuilds` runs; first N-1 are "critical", last is "non-blocking".

**server-logs**: Resolves server aliases via prefix matching (e.g. "next" → "nextjs",
"mobile" → "expo"). Uses `SessionManager.readBuffer` for paginated, regex-filtered output.

## Setup CLI

The `devtools init` command provides an interactive TUI (via `@clack/prompts`) to generate
`.devtools.jsonc` config files. It reads tool names, labels, hints, and defaults entirely
from the Zod schemas and `TOOL_METADATA` registry — no duplication.

See `src/cli.ts` (entry), `src/config-generator.ts` (JSONC generation).
