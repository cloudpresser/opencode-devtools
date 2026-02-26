You are executing a dev task following the Superior Workflow.

## Task Context (auto-fetched)

{{WORK_ITEM_CONTEXT}}

{{MEDIA_CONTEXT}}

## Your Mission

Execute this dev task end-to-end: red/green testing, commit, PR queue.

### Test Infrastructure Bootstrapping

If the target package has no test setup (no `jest.config.ts`, no `"jest"`
section in `package.json`, no `"test"` script):

1. Create `jest.config.ts`:
   ```ts
   const config = {
     clearMocks: true,
     testPathIgnorePatterns: ['/node_modules/', '/dist/'],
   };
   export default config;
   ```
2. Create `babel.config.js`:
   ```js
   module.exports = {
     sourceType: 'unambiguous',
     presets: [
       ['@babel/preset-env', { targets: { chrome: 100 } }],
       '@babel/preset-typescript',
     ],
     plugins: ['@babel/plugin-proposal-export-namespace-from'],
   };
   ```
3. Add to `package.json`:
   - Script: `"test": "jest"`
   - devDependencies: `"@jest/globals": "^29.3.1"`,
     `"@vectorvest/testing-utils": "*"`
4. Include these infrastructure files in the red commit.

## Phase 2: Red Commit (failing test)

This step is MANDATORY. Every PR must demonstrate the fix via
test history.

1. Write a test that DEMONSTRATES the bug or missing behavior:
   - **Maestro** (`.yaml`) for E2E / UI behavior
   - **Jest** for unit tests
   - When writing Jest tests, ALWAYS import from `@jest/globals`:
     `import { describe, expect, it, jest, beforeEach } from '@jest/globals';`
2. Verify the test fails by running the specific test file
   (not the whole suite)
3. Commit using the `commit` tool with `skipHooks: true`:
   - The red commit intentionally has a failing test, so pre-commit
     hooks must be skipped
   - `message`: `test(<scope>): add failing test for <description>`
   - `workdir`: `.`
4. Do NOT analyze why the test fails — the failure IS the point.
   Commit immediately after confirming it fails.

## Phase 3: Green Commit (implement fix)

1. Implement the fix per the task description's Approach section
2. Run the SAME test from Phase 2 — it should now PASS
3. Run `yarn check-types` and `yarn lint` — fix any issues
4. Commit using the `commit` tool (without `skipHooks`):
   - Pre-commit hooks will run and must pass
   - `message`: `fix(<scope>): <description>`
   - `workdir`: `.`
5. Do NOT modify the red test unless absolutely necessary for the fix.
   If you must, explain why in the commit message.

## Phase 4: Queue for Trickle-Push with Scheduled PR

After all commits are made, queue the branch for trickle-push AND
scheduled PR creation using the `push-queue-schedule` tool:

- `branch`: the current branch name
- `estimatedHours`: {{REMAINING_WORK}} (already converted to hours). If "unknown", **omit this parameter entirely** — the tool will use default uniform spacing.
- `prConfig`:
  - `userPrompt`: concise description of the changes
  - `targetBranch`: "staging"
  - `workItems`: array of work item IDs to link (the task ID)
  - `workItemId`: the task's work item ID (for board card movement)

If `{{REMAINING_WORK}}` is "unknown", **omit the `estimatedHours`
parameter entirely**. The tool will fall back to default uniform spacing
(25–45 min between commits).

The tool will:

1. Rewrite commit dates proportionally across the estimated duration
2. Save a PR config file
3. Install a cron job to trickle-push commits during business hours
4. After the final commit is pushed, the cron job automatically:
   - Creates the PR via @cloudpresser/create-pr
   - Moves the task card to Ready for Review (Active)
   - (Future) Notifies the Teams channel

**Do NOT create a PR manually** — the push-queue handles this
after the final push.

**Do NOT push manually** — commits must stay local until their
scheduled push time.

After PR approval:

- **Dev tasks:** Close the dev task
- **Defects:** Move to Ready for QA Review

## Phase 5: Session Complete

All phases are done. Post a completion comment on the work item
using the `work-item-comment` tool:

```
Automated fix applied. Commits queued for trickle-push.
PR will be created automatically after final push.

Summary: <brief description of what was changed and why>
```

### If You Cannot Complete the Task

If you cannot find a solution you are confident with, or if you are
blocked by infrastructure issues (pre-commit hook failures, missing
dependencies, etc.):

1. Post a comment on the work item using the `work-item-comment` tool
   explaining your findings and what blocked you
2. Complete the session — the workflow can be re-run after input
   is provided on the ticket

## Rules (mandatory)

- Red/green testing is REQUIRED for every task — no exceptions
- Max 2 sub-tasks in-progress at any given time
- Estimated completion date includes time for code review and fixes
- No new work if there are open defects or unresolved PR comments
- Dev tasks are closed ONLY after PR review is approved
- Defects are closed ONLY after QA approves AND changes are deployed

## Board Column Movement

```
Ready → In-Progress → Ready for Review → (approval) → Closed
```

For defects after approval:

```
Ready for Review → Ready for QA Review → Ready for Staging QA
  → In QA → Staging QA Done → Closed
```