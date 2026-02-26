You are fixing a defect following the Superior Workflow.

## Defect Context (auto-fetched)

{{DEFECT_CONTEXT}}

### Parent Work Item

{{PARENT_CONTEXT}}

### Pull Request

{{PR_CONTEXT}}

### Active Review Comments

{{PR_COMMENTS}}

{{MEDIA_CONTEXT}}

## Your Mission

Fix this defect. The PR already exists — your commits will be
pushed to the existing branch and update the PR automatically.

### Phase 1: Diagnose

1. Read the defect description and reproduction steps carefully
2. Review the active PR review comments above
3. Examine the relevant code to understand the root cause
4. If the defect includes screenshots or videos, study them
   to understand the expected vs actual behavior

### Phase 2: Red Commit (failing test)

This step is MANDATORY. Every fix must demonstrate the defect via
test history.

1. Write a test that REPRODUCES the defect:
   - **Maestro** (`.yaml`) for E2E / UI behavior
   - **Jest** for unit tests
   - When writing Jest tests, ALWAYS import from `@jest/globals`:
     `import { describe, expect, it, jest, beforeEach } from '@jest/globals';`
2. Verify the test fails by running the specific test file
3. Commit using the `commit` tool with `skipHooks: true`:
   - `message`: `test(<scope>): add failing test for defect #{{DEFECT_ID}}`
   - `workdir`: `.`

### Phase 3: Green Commit (implement fix)

1. Implement the fix
2. Run the SAME test from Phase 2 — it should now PASS
3. Run `yarn check-types` and `yarn lint` — fix any issues
4. Commit using the `commit` tool (without `skipHooks`):
   - `message`: `fix(<scope>): <description> (fixes #{{DEFECT_ID}})`
   - `workdir`: `.`

### Phase 4: Queue for Trickle-Push

Since this branch already has an open PR (#{{PR_ID}}), pushing will
update the existing PR automatically.

Use `push-queue-schedule`:
- `branch`: the current branch name
- `estimatedHours`: {{REMAINING_WORK}} (already converted to hours). If "unknown", **omit this parameter entirely** — the tool will use default uniform spacing.
- `prConfig`:
  - `userPrompt`: concise description of the fix
  - `targetBranch`: "{{TARGET_BRANCH}}"
  - `workItemId`: "{{DEFECT_ID}}"

**Do NOT create a new PR** — the existing PR will be updated.
**Do NOT push manually** — use the push-queue.

### Phase 5: Session Complete

Post a completion comment on the defect using `work-item-comment`:
```
Automated fix applied for defect #{{DEFECT_ID}}.
Commits queued for trickle-push to existing PR #{{PR_ID}}.

Summary: <brief description of what was fixed and why>
```

### If You Cannot Complete the Fix

If blocked or unable to find a confident solution:
1. Post a comment on the defect explaining findings and blockers
2. Complete the session

## Board Column Movement (Defects)

```
Ready → In-Progress → Ready for Review → (approval) →
  Ready for QA Review → Ready for Staging QA →
  In QA → Staging QA Done → Closed
```