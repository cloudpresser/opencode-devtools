/**
 * Implement Workflow — Execute dev tasks in isolated worktrees.
 *
 * Branching: Creates `dev/<id>-<slug>` from a user-specified base
 * branch (typically a feature/ branch created by /plan). The base
 * branch is passed explicitly as the second argument.
 *
 * CLI: devtools implement <workItemId> <baseBranch>
 * Agent bootstraps via: /implement <workItemId>
 */

import type {
  WorkflowDefinition,
  WorkflowParam,
  ResolveContext,
  ResolveResult,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { parseWorkItemId } from "../types";
import { pushQueueConclusion } from "../conclusions";
import { TESTING_GUIDANCE } from "../shared/testing-guidance";
import { afterWriteTypeCheckAndTest } from "../shared/after-write";
import { deriveDevBranch } from "../shared/branch-utils";
import { setEntry } from "../../branch-registry";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a branch name from a work item.
 * Always uses `dev/<id>-<slug>` prefix — the branch targets a feature/
 * or bug/ branch (not staging directly).
 */
export function deriveBranchName(workItem: {
  id: number;
  type: string;
  title: string;
}): string {
  return deriveDevBranch(workItem);
}

// ─── Params ──────────────────────────────────────────────────────────────────

const params: WorkflowParam[] = [
  { name: "workItemId", required: true, description: "Work item ID or URL" },
  { name: "baseBranch", required: true, description: "Branch to create worktree from" },
];

// ─── Resolve (CLI pre-launch) ────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  const workItemId = parseWorkItemId(ctx.params.workItemId);
  const baseBranch = ctx.params.baseBranch;

  if (!workItemId || !baseBranch) return undefined;

  // Fetch work item for branch name derivation
  let branchName: string;
  try {
    const { raw: workItem } = await ctx.utils.fetchWorkItem(workItemId);
    branchName = deriveBranchName(workItem);
  } catch {
    branchName = `dev/${workItemId}`;
  }

  // Register in branch registry
  setEntry(workItemId, {
    branch: branchName,
    targetBranch: baseBranch,
    workflow: "implement",
    createdAt: new Date().toISOString(),
  });

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
  const workItemId = parseWorkItemId(ctx.params.workItemId);
  const baseBranch = ctx.params.baseBranch || "staging";

  if (!workItemId) {
    return {
      userMessage: "Implement: no work item ID provided",
      templateVars: {
        WORK_ITEM_CONTEXT: "No work item ID provided.",
        MEDIA_CONTEXT: "",
        REMAINING_WORK: "unknown",
        TARGET_BRANCH: baseBranch,
        TESTING_GUIDANCE: TESTING_GUIDANCE,
      },
    };
  }

  const { formatted, raw: workItem } = await ctx.utils.fetchWorkItem(
    workItemId,
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
      workItemId,
      Object.values(ctx.params).filter(Boolean).join(" "),
    ),
    templateVars: {
      WORK_ITEM_CONTEXT: formatted,
      MEDIA_CONTEXT: media,
      REMAINING_WORK: remainingStr,
      TARGET_BRANCH: baseBranch,
      TESTING_GUIDANCE: TESTING_GUIDANCE,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const implementWorkflow: WorkflowDefinition = {
  name: "implement",
  description: "Implement a work item in a new worktree",
  requiredTools: ["work-item", "generate"],
  workerTemplate: "worker.md",
  params,
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  injectAfterWrite: [afterWriteTypeCheckAndTest],
  agent: {
    name: "implement",
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
