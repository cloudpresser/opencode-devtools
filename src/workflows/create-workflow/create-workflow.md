You are creating a new instrumented workflow for the opencode-devtools plugin.

## Provided Context

### Session Analysis (if available)

{{SESSION_ANALYSIS}}

### Command File (if available)

{{COMMAND_FILE}}

## Phase 1: Analyze & Propose

Analyze all provided context and design a complete workflow. DO NOT
ask a list of questions — instead, get a head start: form your own
assessment, propose a concrete design, and ask the user to confirm
or adjust.

### If session analysis was provided:

1. Study the session: what task was being performed, what tools were
   used, where did the agent struggle, what patterns emerged
2. Identify what went well (encode these patterns)
3. Identify what went poorly (the workflow should prevent these)
4. Note any tool calls that were unnecessary or missing

### If a command file was provided:

1. Read the command definition and understand the intent
2. This is a starting point — the workflow will add structure,
   context injection, and proper tooling around it

### Always:

Based on your analysis, propose a **complete workflow design**:

1. **Name and description** — what slash command name, one-line purpose
2. **Architecture** — worktree+worker (isolated branch, spawns tmux
   session) or direct (runs in current session)
3. **Conclusion strategy** — how the workflow wraps up:
   - `pushQueueConclusion`: commit tool + push-queue (for dev work
     producing commits)
   - `directPushConclusion`: direct git push (for merge/rebase tasks)
   - `noneConclusion`: no push (for analysis/planning workflows)
4. **Context injection** — what data to fetch and inject into the
   template (work items, PRs, files, custom data)
5. **Required tools** — which tools the workflow needs force-enabled
6. **Template outline** — key phases and instructions for the agent

### Tooling Evaluation (critical)

Evaluate the tool landscape for this workflow:

- **Are existing tools sufficient?** Review the tools available in the
  plugin and assess if they cover the workflow's needs
- **Output format** — Would any existing tool benefit from a different
  output format for this workflow's use case?
- **New tools needed?** If the session analysis or command file reveals
  manual steps, repeated failures, or patterns that a tool could
  automate, propose a new tool:
  - Describe its interface (name, args, return value)
  - Explain what it would automate
  - Note it as a follow-up implementation item

### Propose, Don't Interrogate

Present your complete proposal cohesively. Then ask:
> "Does this design look right? Anything you'd like to change?"

Only iterate on specific points the user raises. Don't ask open-ended
questions about every parameter.

## Phase 2: Implement

After the user confirms the design (with any adjustments), implement
the workflow.

### Files to create in `{{PLUGIN_WORKFLOWS_DIR}}/<name>/`:

1. **`index.ts`** — WorkflowDefinition export with:
   - `resolve()` function (if worktree workflow)
   - `injectWorkerContext()` function
   - Agent configuration (if worktree workflow)
   - `injectAfterWrite` handlers (if applicable)
   - `__dirname: import.meta.dir`

2. **`worker.md`** — Worker template with `{{PLACEHOLDER}}` variables
   matching the keys returned by `injectWorkerContext().templateVars`

3. **`launcher.md`** — (only for worktree workflows) Fallback template
   for when `resolve()` returns undefined

4. **`index.test.ts`** — Tests using `testWorkflowLifecycle()` harness
   plus any custom tests for complex behavior

### Register the workflow:

Add to `{{PLUGIN_INDEX_PATH}}`:
- Import the workflow definition
- Add `registry.register(yourWorkflow)` alongside the other registrations

## Phase 3: Verify

1. Run tests: `bun test src/workflows/<name>/`
2. Run type check: `npx tsc --noEmit`
3. Show the diff via `bunx critique@0.1.50 --web`

## Reference: Framework Architecture

### WorkflowDefinition Interface

```typescript
{{FRAMEWORK_TYPES}}
```

### Conclusion Strategies

```typescript
{{CONCLUSION_STRATEGIES}}
```

### Example: Simplest Workflow (merge-rebase)

**Definition (`index.ts`):**
```typescript
{{EXAMPLE_WORKFLOW}}
```

**Template (`worker.md`):**
```markdown
{{EXAMPLE_TEMPLATE}}
```

### Test Harness

The `testWorkflowLifecycle()` function auto-verifies structural
correctness. Import it and pass your workflow definition:

```typescript
import { testWorkflowLifecycle } from "../testing";
import { myWorkflow } from "./index";

testWorkflowLifecycle({ workflow: myWorkflow });
```

It automatically tests: command registration, template existence,
agent configuration, tool requirements, context injection,
placeholder substitution, and non-interference.

### Key Patterns

- **`usesWorktree: false`** workflows are simple: the framework calls
  `injectWorkerContext()` directly in the current session
- **`usesWorktree: true`** workflows have a launcher (creates worktree)
  and a worker (receives context via `/workflow-run`)
- **`resolve()`** attempts deterministic launch. Return `undefined` to
  fall back to agent mode (launcher template injected, agent asks user)
- **Template variables** use `{{DOUBLE_BRACES}}` syntax. Every key in
  `templateVars` must have a corresponding `{{KEY}}` in the template
- **`injectAfterWrite`** handlers run after file write tools and can
  append feedback (type errors, test results) to the tool output