/**
 * Pre-built conclusion strategies for workflows.
 *
 * A conclusion strategy defines how a workflow wraps up its work.
 * The `templateFragment` is appended to the worker template by the engine,
 * ensuring consistent conclusion instructions without duplication.
 */

import type { ConclusionStrategy, ToolFactory } from "./types";
import { createCommitTool } from "../tools/commit";

// ─── Push Queue Conclusion ────────────────────────────────────────────────────

/**
 * Uses the `commit` tool for staging/committing and `push-queue-schedule`
 * for trickle-pushing during business hours.
 *
 * TODO: Automate work-item comment via onToolAfter hook on push-queue-schedule.
 * The comment should be posted automatically with controlled wording (no internal
 * jargon like "trickle-push") after scheduling completes. Until then, the agent
 * is instructed NOT to post comments — the workflow template handles this.
 */
export const pushQueueConclusion: ConclusionStrategy = {
  name: "push-queue",
  requiredTools: ["push-queue"],
  tools: [createCommitTool as ToolFactory],
  templateFragment: `
## Git & Push Rules

- **NEVER** run \`git add\`, \`git commit\`, or \`git push\` directly via bash.
- Use the \`commit\` tool for ALL staging and committing (it handles \`git add\` internally).
- Use the \`push-queue-schedule\` tool for ALL pushing (it schedules trickle-push during business hours).
- You **MAY** use read-only git commands (\`git status\`, \`git diff\`, \`git log\`, \`git show\`, \`git branch\`, \`git rev-parse\`) freely.

## Task Conclusion

When all work is complete and all tests pass:

1. Use the \`commit\` tool for the final commit (if any uncommitted changes remain)
2. Call \`push-queue-schedule\` with:
   - \`branch\`: current branch name
   - \`estimatedHours\`: your estimate of total work hours
   - \`prConfig\`: \`{ userPrompt: "<summary>", targetBranch: "<base>" }\`

**Do NOT post work-item comments** — completion comments will be posted
automatically after push-queue scheduling.

### Tool Reference

#### \`commit\`
\`\`\`
{ message: string, workdir: string, files?: string[], skipHooks?: boolean }
\`\`\`
- \`skipHooks: true\` — only for red-test commits (intentionally failing)
- \`skipHooks: false\` (default) — for green-test and all other commits

#### \`push-queue-schedule\`
\`\`\`
{ branch: string, estimatedHours?: number, prConfig?: { userPrompt: string, targetBranch: string, workItemId?: string } }
\`\`\`
`,
};

// ─── Direct Push Conclusion ───────────────────────────────────────────────────

/**
 * Pushes directly to the remote branch. No commit tool, no queue.
 * Suitable for workflows that need immediate pushes (e.g., merge-rebase).
 */
export const directPushConclusion: ConclusionStrategy = {
  name: "direct-push",
  templateFragment: `
## Task Conclusion

When all work is complete and all checks pass, push directly to the remote branch:
\`\`\`bash
git push origin HEAD
\`\`\`
`,
};

// ─── No Conclusion ────────────────────────────────────────────────────────────

/**
 * No conclusion phase. The workflow just outputs results.
 * Suitable for planning/analysis workflows.
 */
export const noneConclusion: ConclusionStrategy = {
  name: "none",
  templateFragment: "",
};
