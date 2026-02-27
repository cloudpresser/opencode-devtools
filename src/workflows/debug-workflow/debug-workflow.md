You are diagnosing a workflow infrastructure issue.

## Target Area: {{TARGET_AREA}}

## Session Under Investigation

**Session ID:** `{{SESSION_ID}}`

{{SESSION_ANALYSIS}}

## Plugin Diagnostics

{{DIAGNOSTICS}}

## Registered Workflows

{{REGISTERED_WORKFLOWS}}

## Recent Plugin Logs (last 50 lines)

```
{{RECENT_LOGS}}
```

## Framework Source Files

{{FRAMEWORK_FILES}}

**Plugin source root:** `{{PLUGIN_SRC_DIR}}`

## Diagnostic Methodology

You are debugging a workflow infrastructure issue. Follow this
systematic approach:

### Step 1: Identify the Failure Point

The workflow lifecycle has this chain:

```
User types /command
  → OpenCode fires command.execute.before hook
    → Engine reads input.command + input.arguments
      → For /workflow-run: resolveWorkerDispatch(args) → handleWorkerDispatch()
      → For launchers: resolveCommand(name) → handleLauncher() → resolve()
      → For direct: resolveCommand(name) → handleDirectWorkflow()
        → injectWorkerContext() → substitutePlaceholders() → set output.parts
          → Metadata injected (<!-- worker-metadata: --> or <!-- workflow-metadata: -->)
```

For session resolution:
```
Meta-workflow receives session ID
  → resolveWorkerSession(id, $, client)
    → exportSession(id) → extractTextParts → parseLauncherMetadata
      → If launcher: client.session.list({query: {directory: worktreeDir}})
        → Filter by timestamp → Check each for <!-- worker-metadata: -->
          → Strict match on workflowName → return worker session
          → No match → throw WorkerSessionNotFoundError
```

Determine WHERE in this chain the failure occurred.

### Step 2: Check the Evidence

1. **Check the logs** — Look for:
   - `[init]` messages: Was the plugin loaded? Which workflows registered?
   - `[engine:worker]` messages: Was dispatch attempted? What were the args?
   - `[WARN]` or `[ERROR]`: Any explicit failures?
   - `no workflow found for dispatch args:` — dispatch failure with the actual args
   - `injectWorkerContext failed` — handler threw an error

2. **Check the session** (if provided):
   - Does it have `<!-- workflow-metadata: -->` (launcher) or
     `<!-- worker-metadata: -->` (worker)?
   - What's in the first message? Raw template text = dispatch failed.
     Processed context = dispatch succeeded.
   - What tools did the agent call? If it called `work-item` manually,
     context injection didn't happen.

3. **Check the metadata blocks**:
   - Missing launcher metadata → `handleLauncher` didn't inject it
     (resolve() failed? launchWorker() failed?)
   - Missing worker metadata → `handleWorkerDispatch` didn't run
     (args parsing issue? workflow not found in registry?)

### Step 3: Common Failure Modes

**Dispatch failure (no workflow found):**
- Args wrapped in quotes: `"fix-defect 71448"` instead of `fix-defect 71448`
- Workflow name doesn't match directory name
- Plugin loaded old code (stale cache, not hot-reloaded)
- Registry didn't register the workflow (config gating, import error)

**Session resolution failure (WorkerSessionNotFoundError):**
- Worker session has no `<!-- worker-metadata: -->` because dispatch failed
- SDK client not available (client is null/undefined)
- Session list API returned empty (wrong directory filter, DB issue)
- Timestamp filter too strict (worker created before launchedAt minus tolerance)
- Worker session exists but for a different workflow name

**Context injection failure (template not populated):**
- `injectWorkerContext` threw an error (provider API failure, network issue)
- Template file doesn't exist or is empty
- Placeholder names in template don't match keys in `templateVars`

**Launcher failure (worktree not created):**
- `resolve()` returned undefined (missing args, provider fetch failed)
- `launchWorker()` failed (git worktree error, tmux not available)
- Worker command format wrong (quotes, escaping)

### Step 4: Investigate

Read the framework source files to understand the exact code path.
Key files:
- `engine.ts` — Hook dispatch logic, `handleWorkerDispatch`, `handleLauncher`
- `registry.ts` — `resolveWorkerDispatch`, `resolveCommand`, `getCommandDefinitions`
- `session-resolution.ts` — `resolveWorkerSession`, `parseLauncherMetadata`
- `create-worktree.ts` — `spawnTmuxSession`, `createWorktreeDirect`

Use the `session-analysis` tool with verbose mode for deeper session inspection.
Use the `devtools-diagnostics` tool for current runtime state.

### Step 5: Propose Fix

Once you've identified the root cause:
1. Explain the failure chain clearly
2. Propose a specific code fix (show the exact change)
3. Explain why it prevents the issue
4. Consider edge cases and whether similar issues exist elsewhere
5. If a new test case would catch this, write it

### Step 6: Implement (if approved)

Edit the source files, run tests (`bun test`), type check (`npx tsc --noEmit`),
and show the diff via `bunx critique@0.1.50 --web`.