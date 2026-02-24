You are executing a dev task following the Superior Workflow.

## Task Context (auto-fetched)

{{WORK_ITEM_CONTEXT}}

## Your Mission

Execute this dev task end-to-end: branch, red/green testing, PR.

## Phase 1: Setup — Create Worktree

1. Read the task description above for: branch name, base branch,
   files to modify, approach, acceptance criteria
2. **ASK the user** to confirm the base branch
3. Call the `create-worktree` tool with `branchName` and `baseBranch`.
   The tool automatically:
   - Detects bare vs regular repo for worktree placement
   - Creates the git worktree and branch
   - Symlinks `node_modules` from the session directory if lockfiles
     match, or runs `yarn install` if they differ
4. Use the returned absolute path as `WORKTREE_DIR` for ALL
   subsequent operations

### CRITICAL: Absolute Paths Required

The session remains in `{{SESSION_DIRECTORY}}`. There is no way to
change the session directory programmatically, so you MUST:

- Use the `workdir` parameter for ALL Bash tool calls, set to
  `WORKTREE_DIR`
- Use absolute paths for ALL file tools (Read, Edit, Write, Grep,
  Glob) — resolve paths relative to the worktree directory
- NEVER use relative paths — they will resolve against the session
  directory, not the worktree

Example: To edit `packages/foo/src/bar.ts` in the worktree:

- Read: `WORKTREE_DIR/packages/foo/src/bar.ts`
- Bash: set `workdir` to `WORKTREE_DIR` with command `yarn check-types`

## Phase 2: Red Commit (failing test)

This step is MANDATORY. Every PR must demonstrate the fix via
test history.

1. Write a test that exposes the bug or missing behavior:
   - **Maestro** (`.yaml`) for E2E / UI behavior
   - **Jest** for unit tests
2. Verify the test fails
3. Commit with conventional prefix (run git in `WORKTREE_DIR`):
   ```
   test(<scope>): add failing test for <description>
   ```

Remember: use `workdir` set to `WORKTREE_DIR` for all git and
yarn commands. Use absolute paths for all file operations.

## Phase 3: Green Commit (implement fix)

1. Implement the fix per the task description's Approach section
2. Verify the previously failing test now passes
3. Run `yarn check-types` and `yarn lint` in `WORKTREE_DIR` — fix
   any issues
4. Commit with conventional prefix (run git in `WORKTREE_DIR`):
   ```
   fix(<scope>): <description>
   ```

## Phase 4: Queue for Trickle-Push with Scheduled PR

After all commits are made, queue the branch for trickle-push AND
scheduled PR creation using the `push-queue-schedule` tool:

- `branch`: the worktree branch name
- `estimatedHours`: {{REMAINING_WORK}} (from the task's RemainingWork)
- `prConfig`:
  - `userPrompt`: concise description of the changes
  - `targetBranch`: "staging"
  - `workItems`: array of work item IDs to link (the task ID)
  - `workItemId`: the task's work item ID (for board card movement)

If `{{REMAINING_WORK}}` is "unknown", parse the "Estimated" line
from the task description:

- "0.5 day" = 4 hours
- "1 day" = 8 hours
- "X days" = X \* 8 hours

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

## Phase 5: QA Handoff (last dev task only)

If this is the LAST dev task for the parent work item:

<!-- TODO: Build a custom `qa-handoff` tool that detects remaining
open dev tasks under the parent, composes the notification message
with PR links, and posts to the Teams channel automatically. For now,
the agent must ask the user to complete this step manually. -->

**Ask the user** to post the following in the Superior Engineering
Teams channel:

```
<Parent Type> <Parent ID>: <Parent Title>

Pull Request <PR_NUMBER>: <PR title>

These are ready for testing. @<QA members>
```

The agent cannot post to Teams directly — the user must do this.

## Phase 6: Session Handoff

After completing all phases, inform the user:

> Worktree created at `WORKTREE_DIR`.
> To continue working in this worktree, run: `/cd WORKTREE_DIR`
> To clean up when done, call the `remove-worktree` tool with
> the branch name. The branch itself is preserved.

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
