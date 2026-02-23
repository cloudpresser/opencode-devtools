#!/usr/bin/env bash
# push-queue.sh — cron-driven trickle-push for git branches
# Usage: push-queue.sh <branch> [remote] [repo-path]
# Pushes only commits whose author date has already passed.
# Self-removes from crontab when all commits are pushed.
set -euo pipefail

BRANCH="${1:?Usage: push-queue.sh <branch> [remote] [repo-path]}"
REMOTE="${2:-origin}"
REPO="${3:-$(pwd)}"

cd "$REPO"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

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
fi
