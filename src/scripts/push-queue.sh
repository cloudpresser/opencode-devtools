#!/usr/bin/env bash
# push-queue.sh — cron-driven trickle-push for git branches
# Usage: push-queue.sh <branch> [remote] [repo-path]
# Pushes only commits whose author date has already passed.
# Self-removes from crontab when all commits are pushed.
# After final push, creates PR and updates board if config exists.
set -euo pipefail

# Ensure tools are available in cron's minimal environment
export PATH="/opt/homebrew/bin:$PATH"
# shellcheck disable=SC1091
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"

BRANCH="${1:?Usage: push-queue.sh <branch> [remote] [repo-path]}"
REMOTE="${2:-origin}"
REPO="${3:-$(pwd)}"

cd "$REPO"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Post-Push Actions ────────────────────────────────────────────────────────
# After all commits are pushed, create PR and update board if configured.

post_push_actions() {
  local PR_CONFIG="/tmp/push-queue-pr-${BRANCH}.json"
  if [[ ! -f "$PR_CONFIG" ]]; then
    log "No PR config found — skipping post-push actions"
    return 0
  fi

  log "Found PR config — creating pull request..."

  # Parse JSON config using python3
  local USER_PROMPT TARGET_BRANCH WORK_ITEM_ID WORK_ITEMS_ARGS
  USER_PROMPT=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('userPrompt',''))" "$PR_CONFIG")
  TARGET_BRANCH=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('targetBranch','staging'))" "$PR_CONFIG")
  WORK_ITEM_ID=$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('workItemId',''))" "$PR_CONFIG")
  WORK_ITEMS_ARGS=$(python3 -c "
import json,sys
c=json.load(open(sys.argv[1]))
items=c.get('workItems',[])
print(' '.join(['--workItems ' + str(w) for w in items]))
" "$PR_CONFIG" 2>/dev/null || echo "")

  # Retry up to 3 times
  local ATTEMPT=0
  local MAX_RETRIES=3
  local PR_CREATED=false
  local PR_URL=""
  local PR_OUTPUT=""

  while [[ $ATTEMPT -lt $MAX_RETRIES ]]; do
    ATTEMPT=$((ATTEMPT + 1))
    log "PR creation attempt $ATTEMPT/$MAX_RETRIES..."

    # Pipe answers to interactive prompts:
    # n = don't edit title, n = don't edit description, y = create PR
    PR_OUTPUT=$(printf 'n\nn\ny\n' | npx @cloudpresser/create-pr \
      --userPrompt "$USER_PROMPT" \
      --targetBranch "$TARGET_BRANCH" \
      --sourceBranch "$BRANCH" \
      $WORK_ITEMS_ARGS 2>&1) || true

    if echo "$PR_OUTPUT" | grep -qE "https://dev\.azure\.com"; then
      PR_CREATED=true
      PR_URL=$(echo "$PR_OUTPUT" | grep -oE 'https://dev\.azure\.com[^ )"]*' | head -1)
      log "PR created: $PR_URL"
      break
    else
      log "PR creation failed (attempt $ATTEMPT): $(echo "$PR_OUTPUT" | tail -3)"
      if [[ $ATTEMPT -lt $MAX_RETRIES ]]; then
        log "Retrying in 30s..."
        sleep 30
      fi
    fi
  done

  if [[ "$PR_CREATED" == "true" ]]; then
    # Move task card to Active (Ready for Review)
    if [[ -n "$WORK_ITEM_ID" ]]; then
      log "Moving work item $WORK_ITEM_ID to Active..."
      az boards work-item update --id "$WORK_ITEM_ID" --state "Active" 2>&1 | head -1 || log "WARNING: Failed to update work item"
    fi

    # TODO: Send notification to Teams channel.
    # When implemented, this should post to the Superior Engineering
    # Teams channel with the PR URL, work item details, and reviewer
    # assignment. For now we just log the intent.
    log "NOTIFY: PR ready for review — $PR_URL (work item: $WORK_ITEM_ID)"

    rm -f "$PR_CONFIG"
    log "Post-push actions complete"
  else
    log "ERROR: PR creation failed after $MAX_RETRIES attempts."
    log "Config preserved at $PR_CONFIG for manual retry."
  fi
}

log "=== push-queue run for ${REMOTE}/${BRANCH} ==="

# Fetch latest remote state
git fetch "$REMOTE" "$BRANCH" --quiet 2>/dev/null || true

REMOTE_TIP=$(git rev-parse "${REMOTE}/${BRANCH}" 2>/dev/null || echo "")
LOCAL_TIP=$(git rev-parse "$BRANCH" 2>/dev/null || echo "")

if [[ -z "$LOCAL_TIP" ]]; then
  log "ERROR: local branch '$BRANCH' not found"
  exit 1
fi

if [[ "$REMOTE_TIP" == "$LOCAL_TIP" ]]; then
  log "Nothing to push — local and remote are identical"
  log "Removing cron job..."
  crontab -l 2>/dev/null | grep -v "push-queue\.sh.*${BRANCH}" | crontab - 2>/dev/null || true
  log "Done — cron job removed"
  post_push_actions
  exit 0
fi

# List local-only commits, oldest first
if [[ -n "$REMOTE_TIP" ]]; then
  COMMITS=$(git log --reverse --format='%H %aI' "${REMOTE_TIP}..${BRANCH}")
else
  COMMITS=$(git log --reverse --format='%H %aI' "$BRANCH")
fi

if [[ -z "$COMMITS" ]]; then
  log "No unpushed commits found"
  exit 0
fi

NOW=$(date +%s)
PUSH_UP_TO=""

while IFS=' ' read -r SHA DATE; do
  # Convert author date to epoch
  # Strip timezone — take first 19 chars: YYYY-MM-DDTHH:MM:SS
  DATE_LOCAL="${DATE:0:19}"
  EPOCH=$(date -jf '%Y-%m-%dT%H:%M:%S' "$DATE_LOCAL" +%s 2>/dev/null || date -d "$DATE" +%s 2>/dev/null || echo 0)
  if [[ "$EPOCH" -le "$NOW" ]]; then
    PUSH_UP_TO="$SHA"
    log "  ready: ${SHA:0:10} ($DATE)"
  else
    log "  waiting: ${SHA:0:10} ($DATE)"
  fi
done <<< "$COMMITS"

if [[ -z "$PUSH_UP_TO" ]]; then
  log "No commits ready yet (all dates in the future)"
  exit 0
fi

log "Pushing up to ${PUSH_UP_TO:0:10}..."
git push --force-with-lease "$REMOTE" "${PUSH_UP_TO}:refs/heads/${BRANCH}"
log "Push successful"

# Check if we've pushed everything
NEW_LOCAL_TIP=$(git rev-parse "$BRANCH" 2>/dev/null)
NEW_REMOTE_TIP=$(git rev-parse "${REMOTE}/${BRANCH}" 2>/dev/null || echo "")
# Re-fetch to confirm
git fetch "$REMOTE" "$BRANCH" --quiet 2>/dev/null || true
NEW_REMOTE_TIP=$(git rev-parse "${REMOTE}/${BRANCH}" 2>/dev/null || echo "")

if [[ "$NEW_REMOTE_TIP" == "$NEW_LOCAL_TIP" ]]; then
  log "All commits pushed! Removing cron job..."
  crontab -l 2>/dev/null | grep -v "push-queue\.sh.*${BRANCH}" | crontab - 2>/dev/null || true
  log "Done — cron job removed"
  post_push_actions
fi
