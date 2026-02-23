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

## Phase 4: Create PR

<!-- TODO: Build a custom `superior-pr` tool that handles the full
PR workflow end-to-end: create PR, auto-assign reviewer (developer
with fewest PRs), post notification in Teams channel, and move the
board card to Ready for Review — all in one step. -->

1. Use the `create-pr` tool to create the PR targeting `staging`.
   Ensure all git commands run in `WORKTREE_DIR`.
2. PR title should follow conventional commit format
3. PR description should reference the work item ID
4. Assign a reviewer:
   - Choose the developer with fewest PRs assigned
   - If all equal, choose any available developer
5. Notify in the Superior Engineering Teams channel
6. Move the task card to **Ready for Review**:
   ```bash
   az boards work-item update --id <TASK_ID> --state "Active"
   ```

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
