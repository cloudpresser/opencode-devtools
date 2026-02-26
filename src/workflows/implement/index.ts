/**
 * Implement Workflow — Work item driven development with worktrees.
 *
 * Launcher: /implement <workItemId> [baseBranch]
 * Worker: receives context via /workflow-run implement <workItemId>
 *
 * Replaces the old superior-execute + superior-work commands.
 */

import type {
  WorkflowDefinition,
  ResolveContext,
  ResolveResult,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { pushQueueConclusion } from "../conclusions";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a branch name from a work item.
 * Bug → "bug/<id>-<slug>", otherwise → "feature/<id>-<slug>".
 */
export function deriveBranchName(workItem: {
  id: number;
  type: string;
  title: string;
}): string {
  const typePrefix =
    workItem.type.toLowerCase() === "bug" ? "bug" : "feature";
  const slug = workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `${typePrefix}/${workItem.id}-${slug}`;
}

// ─── Resolve (Launcher) ──────────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  const parts = ctx.args.split(/\s+/);
  const workItemId = ctx.workItemId;
  const baseBranch = parts[1] || null;

  // Need both workItemId AND baseBranch for deterministic launch
  if (!workItemId || !baseBranch) return undefined;

  // Fetch work item for branch name derivation
  let branchName: string;
  try {
    const { raw: workItem } = await ctx.utils.fetchWorkItem(workItemId);
    branchName = deriveBranchName(workItem);
  } catch {
    branchName = `task/${workItemId}`;
  }

  return {
    branchName,
    baseBranch,
    workerArgs: workItemId,
    reuseExisting: false,
  };
};

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  if (!ctx.workItemId) {
    return {
      userMessage: `Implement: ${ctx.args}`,
      templateVars: {
        WORK_ITEM_CONTEXT: "No work item ID provided.",
        MEDIA_CONTEXT: "",
        REMAINING_WORK: "unknown",
      },
    };
  }

  const { formatted, raw: workItem } = await ctx.utils.fetchWorkItem(
    ctx.workItemId,
  );

  const media = await ctx.utils.processMedia(
    workItem.fields || {},
    workItem.attachments,
  );

  const remaining =
    workItem.fields?.["Microsoft.VSTS.Scheduling.RemainingWork"];
  // RemainingWork is stored in work days — convert to hours (1 day = 8h)
  const remainingStr =
    remaining != null ? String(Number(remaining) * 8) : "unknown";

  return {
    userMessage: ctx.utils.generateUserMessage(
      "implement",
      workItem,
      ctx.workItemId,
      ctx.args,
    ),
    templateVars: {
      WORK_ITEM_CONTEXT: formatted,
      MEDIA_CONTEXT: media,
      REMAINING_WORK: remainingStr,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const implementWorkflow: WorkflowDefinition = {
  name: "implement",
  description: "Implement a work item in a new worktree",
  requiredTools: ["work-item"],
  workerTemplate: "worker.md",
  launcherTemplate: "launcher.md",
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  agent: {
    name: "implement-worker",
    model: "opencode/claude-opus-4-6",
    mode: "all",
    description:
      "Autonomous worker for implementing dev tasks in isolated worktrees",
    disabledTools: [
      "work-item",
      "work-item-comment",
      "create-pr",
      "get-pr",
      "pr-comments",
      "push-queue-logs",
      "push-queue-jobs",
      "create-worktree",
      "remove-worktree",
      "build-status",
      "session-analysis",
    ],
    permissions: ["external_directory", "doom_loop"],
  },
  __dirname: import.meta.dir,
};
