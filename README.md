# opencode-devtools

Verification and build-status primitives for AI agent execution — type checking, testing, and CI as control-loop gates.

An [OpenCode](https://github.com/anomalyco/opencode) plugin that exposes development infrastructure as AI-callable tools. Instead of the agent guessing whether its changes compile or pass tests, these tools give the execution loop hard verification constraints: type-check, lint, run tests, check CI — then decide.

## Why This Exists

In a control-system architecture (intent → orchestration → execution → **verification** → supervision), verification is the gate between "the agent did something" and "a human should look at it." Without verification primitives, the agent runs blind and the human reviews everything. With them, the loop self-corrects before surfacing results.

This plugin implements that verification layer for software development workflows. The primitives are domain-specific (TypeScript, ESLint, test runners, CI), but the pattern is general: **give the agent observable constraints so it can converge before asking for human attention.**

## Tools

| Tool | What it does | Execution |
|------|-------------|-----------|
| `dev-server` | Start and manage Expo/Next.js dev servers | PTY (long-running) |
| `server-logs` | Read server output with filtering and pagination | PTY buffer |
| `check-types` | TypeScript type checking | Bun.$ |
| `lint` | ESLint with auto-fix support | Bun.$ |
| `generate` | Code scaffolding from templates | Bun.$ |
| `create-pr` | Interactive PR creation (auto-answers prompts) | PTY |
| `run-tests` | Test execution with aggregated results | Bun.$ / PTY |
| `build-status` | CI pipeline monitoring (Azure DevOps) | Bun.$ / PTY |

## Setup

Register as a plugin in your `opencode.json`:

```json
{
  "plugins": {
    "devtools": {
      "path": "path/to/opencode-devtools"
    }
  }
}
```

Then optionally run the setup CLI:

```bash
bunx devtools init
```

This generates a `.devtools.jsonc` config file with tool toggles and per-tool configuration.

## Configuration

All config lives in `.devtools.jsonc` (or `.devtools.json`) at the project root. Validated with Zod schemas. Falls back to sensible defaults when no config file exists.

**Default tool enablement:**
- Enabled: dev-server, server-logs, check-types, lint, run-tests
- Disabled: generate, create-pr, build-status

See [ARCHITECTURE.md](ARCHITECTURE.md) for schema hierarchy and implementation details.

## Architecture

Two execution strategies based on tool needs:

1. **Bun.$** — For commands that run to completion (type checking, linting, tests)
2. **bun-pty** — For long-running or interactive processes (dev servers, CI watch, PR creation)

PTY sessions are managed by a singleton SessionManager with a 50k-line rolling buffer per session, supporting paginated reads and regex filtering.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical breakdown.

## Part of a Larger Stack

This repo is one layer of a control-system architecture for supervised AI execution:

| Layer | Repo |
|-------|------|
| Supervision | [react-native-opencode-client](https://github.com/cloudpresser/react-native-opencode-client) |
| **Verification** | **opencode-devtools** (this repo) |
| Execution | [OpenCode](https://github.com/anomalyco/opencode) |
| Learned Policy | [opencode-learn](https://github.com/cloudpresser/opencode-learn) |
| Epistemic Safety | [agent-memory-failure-demo](https://github.com/cloudpresser/agent-memory-failure-demo) |

Read the full thesis at [cloudpresser.com](https://cloudpresser.com).

## License

MIT
