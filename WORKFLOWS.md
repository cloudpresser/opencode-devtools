# Workflows

Workflows are the automation layer above individual tools. They
orchestrate multi-step development tasks — from work item discovery
through branch creation, code changes, testing, and push scheduling.

## Overview

Each workflow is defined by a `WorkflowDefinition` in
`src/workflows/<name>/index.ts`. The definition includes:

- **`resolve`**: Pre-launch context resolution (branch discovery,
  registry lookup). Returns `ResolveResult` for deterministic launch
  or `undefined` for agent-mode fallback.
- **`injectWorkerContext`**: Injects template variables into the
  worker template before the agent session starts.
- **`conclusion`**: Strategy for how the agent concludes its work
  (push-queue, direct push, or none).
- **`injectAfterWrite`**: Hooks that run after every file write
  (e.g., type-check + test).

### Execution Patterns

| Pattern     | Workflows              | How it works                                                    |
| ----------- | ---------------------- | --------------------------------------------------------------- |
| **Worktree**    | implement, fix-defect  | Creates isolated git worktree, spawns worker agent in tmux      |
| **Direct**      | plan                   | Runs in the current session (no worktree, no separate agent)    |

### Dispatch Lifecycle

```
User runs /implement 70001 feature/70000-add-dark-mode
  → Engine matches "implement" command in WorkflowRegistry
  → resolve() runs: fetches work item, derives branch, registers in registry
  → If resolve returns ResolveResult:
      → create-worktree with branchName + baseBranch
      → spawn worker agent in tmux with /workflow-run implement 70001
      → abort launcher session
  → If resolve returns undefined:
      → inject launcher template for agent-mode fallback
      → agent assists user interactively

Worker agent starts in worktree:
  → Engine matches "workflow-run" command
  → injectWorkerContext() runs: fetches work item, processes media
  → Worker template + conclusion fragment are populated with template vars
  → Agent executes phases: diagnose → red test → green fix → session complete
  → After each file write, afterWrite hooks run (type-check + test)
  → Conclusion strategy handles push-queue scheduling
```

## Branching Strategy

### Branch Hierarchy

```
Main (production)
  └── Hotfix (emergency, merges → Main + Staging)

Staging (integration)
  ├── feature/<id>-<slug>  (created by /plan for User Stories/Tasks)
  │   ├── dev/<id>-<slug>  (created by /implement for sub-tasks)
  │   └── dev/<id>-<slug>  (created by /fix-defect for defects)
  └── bug/<id>-<slug>      (created by /plan for Bugs)
      ├── dev/<id>-<slug>  (created by /implement for sub-tasks)
      └── dev/<id>-<slug>  (created by /fix-defect for defects)
```

### Workflow → Branch Mapping

| Workflow      | Branch prefix    | Base branch                                | Creates PR targeting    |
| ------------- | ---------------- | ------------------------------------------ | ----------------------- |
| `/plan`         | feature/ or bug/ | staging                                    | staging                 |
| `/implement`    | dev/             | explicit arg (usually a feature/ branch)   | baseBranch arg          |
| `/fix-defect`   | dev/             | parent's branch from registry (auto-lookup) | parent's branch         |

### Concrete Example

```
/plan 70000  (User Story: "Add dark mode")
  → creates feature/70000-add-dark-mode from staging
  → registers: 70000 → feature/70000-add-dark-mode
  → creates sub-tasks 70001, 70002, 70003
  → tells user: /implement 70001 feature/70000-add-dark-mode

/implement 70001 feature/70000-add-dark-mode
  → creates dev/70001-add-toggle-component from feature/70000-add-dark-mode
  → registers: 70001 → dev/70001-add-toggle-component
  → PR targets feature/70000-add-dark-mode

/fix-defect 70003
  → fetches defect, finds parent=70000
  → looks up 70000 in registry → feature/70000-add-dark-mode
  → creates dev/70003-dark-mode-flicker from feature/70000-add-dark-mode
  → registers: 70003 → dev/70003-dark-mode-flicker
  → PR targets feature/70000-add-dark-mode
```

## Branch Registry

Persistent mapping of work item IDs to branch names, stored at
`~/.local/share/opencode-devtools/branch-registry.json`.

### Schema

```json
{
  "70000": {
    "branch": "feature/70000-add-dark-mode",
    "targetBranch": "staging",
    "workflow": "plan",
    "createdAt": "2026-02-26T19:00:00.000Z"
  },
  "70001": {
    "branch": "dev/70001-add-toggle-component",
    "targetBranch": "feature/70000-add-dark-mode",
    "workflow": "implement",
    "createdAt": "2026-02-26T19:30:00.000Z"
  }
}
```

### Write side

| Who                          | When                                          |
| ---------------------------- | --------------------------------------------- |
| `register-branch` tool       | Plan agent creates feature/bug branch         |
| implement `resolve()`         | Implement creates dev/ branch                 |
| fix-defect `resolve()`        | Fix-defect creates dev/ branch                |

### Read side

| Who                          | When                                          |
| ---------------------------- | --------------------------------------------- |
| fix-defect `resolve()`        | Looks up parent work item's branch            |

### Programmatic API (`src/branch-registry.ts`)

```typescript
getEntry(workItemId: string): BranchEntry | undefined
setEntry(workItemId: string, entry: BranchEntry): void
removeEntry(workItemId: string): void
getAllEntries(): Record<string, BranchEntry>
```

## Workflow Reference

### `/plan <workItemId>`

Breaks down a work item (User Story or Bug) into implementable
sub-tasks. Creates a feature/ or bug/ branch from Staging and
registers it in the branch registry.

- **Runs in**: Current session (no worktree)
- **Conclusion**: None
- **Output**: Sub-task work items on Azure DevOps + handoff commands

### `/implement <workItemId> <baseBranch>`

Executes a dev task in an isolated worktree. Creates a `dev/` branch
from the specified baseBranch (typically a feature/ branch from `/plan`).

- **Runs in**: Isolated worktree + tmux worker agent
- **Conclusion**: `pushQueueConclusion` (commit → push-queue → auto PR)
- **AfterWrite**: Type-check + tests run automatically after each file write

### `/fix-defect <defectId> [baseBranch]`

Fixes a defect in an isolated worktree. Auto-discovers the parent
work item's branch from the registry. Falls back to launcher mode
(asks user) if no registry entry is found.

- **Runs in**: Isolated worktree + tmux worker agent
- **Conclusion**: `pushQueueConclusion` (commit → push-queue → auto PR)
- **AfterWrite**: Type-check + tests run automatically after each file write

## Conclusion Strategies

| Strategy              | Used by                 | What it does                                         |
| --------------------- | ----------------------- | ---------------------------------------------------- |
| `pushQueueConclusion`   | implement, fix-defect   | `commit` tool + `push-queue-schedule` (business hours)  |
| `directPushConclusion`  | merge-rebase            | Immediate `git push origin HEAD`                       |
| `noneConclusion`        | plan                    | No conclusion phase                                  |

The conclusion strategy appends a `templateFragment` to the worker
template with specific instructions and tool references for how the
agent should wrap up its work.

## AfterWrite Hooks

The `afterWriteTypeCheckAndTest` hook runs after every `.ts`/`.tsx`
file write by the agent. It:

1. Runs `yarn check-types` — appends `--- TYPE CHECK: PASSED ---` or
   `--- TYPE CHECK: ERRORS FOUND ---` to the tool output
2. Runs `yarn test` (uses Nx cache for fast execution) — appends
   `--- TESTS: PASSED ---` or `--- TESTS: FAILING ---`

The agent is instructed to read these automatic outputs and NOT
manually re-run check-types, lint, or tests.

## Shared Modules

| Module                                | What it provides                                     |
| ------------------------------------- | ---------------------------------------------------- |
| `src/workflows/shared/testing-guidance.ts` | `TESTING_GUIDANCE` constant for `{{TESTING_GUIDANCE}}` var |
| `src/workflows/shared/after-write.ts`      | `afterWriteTypeCheckAndTest` handler                   |
| `src/workflows/shared/branch-utils.ts`     | `deriveSlug()`, `deriveDevBranch()` helpers              |
| `src/branch-registry.ts`                  | Branch registry API (`getEntry`, `setEntry`, etc.)       |

## Creating a New Workflow

1. Create directory: `src/workflows/<name>/`
2. Define `WorkflowDefinition` in `index.ts`
3. Create worker template: `<name>.md` (or `worker.md`) with
   `{{PLACEHOLDER}}` variables
4. Register in `src/index.ts` (import + `registry.register()`)
5. Add tests using `testWorkflowLifecycle()` harness from
   `src/workflows/testing.ts`
6. Choose a conclusion strategy or create a new one in
   `src/workflows/conclusions.ts`
