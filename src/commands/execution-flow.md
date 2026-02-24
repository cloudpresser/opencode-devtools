# Superior Workflow — Execution Flow

This document describes the full pipeline from when a developer
invokes `/superior-execute` to when the PR is created and the
board is updated. It serves as a reference for understanding how
the scheduling, pushing, and PR creation systems work together.

## Overview

```
Developer invokes /superior-execute <task-id>
          │
          ▼
┌─────────────────────────────────────────────────┐
│  OpenCode Agent (interactive session)           │
│                                                 │
│  Phase 1: Create worktree (create-worktree)     │
│  Phase 2: Red commit (failing test)             │
│  Phase 3: Green commit (implement fix)          │
│  Phase 4: push-queue-schedule                   │
│     ├── Rewrite commit author/committer dates   │
│     ├── Write /tmp/push-queue-pr-<branch>.json  │
│     └── Install cron job (*/5 * * * *)          │
│  Phase 5: QA handoff reminder (last task only)  │
│  Phase 6: Session handoff                       │
└─────────────────────────────────────────────────┘
          │
          │  Code stays LOCAL — nothing is pushed yet
          │
          ▼  (hours/days later, cron fires every 5 min)
┌─────────────────────────────────────────────────┐
│  push-queue.sh (cron job)                       │
│                                                 │
│  1. git fetch to check remote state             │
│  2. List unpushed commits                       │
│  3. For each commit:                            │
│       if author_date <= now → mark "ready"      │
│       else → mark "waiting"                     │
│  4. git push --force-with-lease up to latest    │
│     ready commit                                │
│  5. Repeat every 5 min until all pushed         │
│                                                 │
│  After final push:                              │
│     ├── Self-remove from crontab                │
│     ├── Read /tmp/push-queue-pr-<branch>.json   │
│     ├── npx @cloudpresser/create-pr (3 retries) │
│     ├── az boards work-item update → Active     │
│     ├── [TODO] Teams notification               │
│     └── Clean up PR config file                 │
└─────────────────────────────────────────────────┘
```

## Commit Date Scheduling

### Default (uniform spacing)

When `estimatedHours` is not provided, commits are spaced
`minSpacing` to `maxSpacing` minutes apart (default 25–45 min)
during business hours (Mon–Fri, 8am–5pm).

### Proportional spacing

When `estimatedHours` is provided (via the task's RemainingWork):

1. Total hours perturbed by ±15% for natural variation
2. Total minutes distributed across (N-1) gaps between N commits
3. Each gap = base_gap _ (0.7 + 0.3 _ random)
   - 70% fixed component dominates
   - 30% random component adds variation
4. Gaps normalized to sum to total perturbed minutes
5. `nextBusinessSlot()` handles day/hour boundary rollover

Example: 4-hour task with 2 commits (red + green)

- Total budget: ~3.4–4.6 hours (±15%)
- Single gap between commits: e.g., 3.8 hours
- Commit 1 at 9:00am, Commit 2 at 12:48pm

### Cross-branch scheduling

When multiple branches are queued, new schedules start AFTER the
latest existing scheduled commit across all active queues. This
prevents suspicious clustering of commits across branches.

## PR Creation Flow

### Config file format

Written by `push-queue-schedule` to `/tmp/push-queue-pr-<branch>.json`:

```json
{
  "userPrompt": "concise description of changes",
  "targetBranch": "staging",
  "sourceBranch": "bug/71036-login-button-loading",
  "workItems": ["71392"],
  "workItemId": "71392"
}
```

### Automation via push-queue.sh

After the final commit is pushed:

1. Script reads the JSON config file
2. Invokes `npx @cloudpresser/create-pr` with the config values
3. Pipes `printf 'n\nn\ny\n'` to auto-answer interactive prompts:
   - `n` = don't edit AI-generated title
   - `n` = don't edit AI-generated description
   - `y` = yes, create the PR
4. Extracts PR URL from output via regex
5. Retries up to 3 times (30s between attempts) on failure
6. On success: updates the Azure DevOps task card to Active state

### Cron environment

The push-queue.sh script initializes PATH for cron's minimal
environment:

```bash
export PATH="/opt/homebrew/bin:$PATH"    # az, python3
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"  # npx
```

Required tools in cron context:

- `npx` — for @cloudpresser/create-pr (via nvm)
- `az` — for board card movement (via Homebrew)
- `python3` — for JSON parsing (via Homebrew)
- `git` — for push operations

Authentication:

- Azure DevOps PAT — read from `.cloudpresser` env files
- OpenAI API key — read from `.cloudpresser` env files
  (needed for AI-generated PR title/description)

### Error handling

If PR creation fails after 3 retries:

- The JSON config is preserved at `/tmp/push-queue-pr-<branch>.json`
- The cron job has already been removed (push is complete)
- Manual retry: re-run `post_push_actions` logic or create PR manually
- The agent will NOT automatically retry — human intervention needed

## Board Movement

| Event                   | Card state change     |
| ----------------------- | --------------------- |
| Developer picks up task | Ready → In-Progress   |
| PR created (auto)       | In-Progress → Active  |
| PR approved             | Developer closes task |
| Last task approved      | QA notified           |

## File Locations

| File                                  | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `src/tools/push-queue.ts`             | Schedule tool (date rewrite, cron, prConfig write)  |
| `src/scripts/push-queue.sh`           | Cron script (push, PR creation, board update)       |
| `/tmp/push-queue-pr-<branch>.json`    | PR config (written at schedule, consumed post-push) |
| `/tmp/git-push-<branch>-YYYYMMDD.log` | Push queue logs                                     |

## Future Work

| Feature                 | Status      | Description                                      |
| ----------------------- | ----------- | ------------------------------------------------ |
| Teams notification      | Placeholder | Notify Superior channel after PR creation        |
| Reviewer assignment     | Placeholder | Auto-assign reviewer (developer with fewest PRs) |
| `create-work-item` tool | TODO        | Replace `az` CLI for Azure DevOps task creation  |
| `qa-handoff` tool       | TODO        | Detect last task, compose QA notification        |
