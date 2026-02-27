You are launching a dev task.

## Task Info

Work item ID: **{{WORK_ITEM_ID}}**

## Your Mission

Set up the worktree and launch the worker session. This session
handles ONLY the setup — the actual implementation happens in a
new tmux window.

## Setup — Create Worktree

1. **ASK the user** which base branch to use (e.g., `staging`,
   `main`, or a feature branch)
2. Call the `create-worktree` tool with:
   - `branchName`: `{{BRANCH_NAME}}`
   - `baseBranch`: the branch the user confirmed
   - `prompt`: `implement {{WORK_ITEM_ID}}`
3. The tool will:
   - Create the git worktree and branch
   - Set up node_modules with proper workspace resolution
   - Set up husky pre-commit hooks
   - Spawn a new OpenCode session in a tmux window
4. **STOP.** Inform the user that the worktree is ready and
   work continues in the new tmux window.

### Worktree Creation Failure = Session Abort

If the `create-worktree` tool fails, the session is automatically
aborted. The user must fix the issue externally and re-run.