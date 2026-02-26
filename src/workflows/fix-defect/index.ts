/**
 * Defect Workflow — Fix defects linked to existing PRs.
 *
 * Launcher: /fix-defect <defectId> [baseBranch]
 * Worker: receives context via /workflow-run fix-defect <defectId>
 *
 * Replaces the old superior-defect + superior-defect-work commands.
 */

import type {
  WorkflowDefinition,
  ResolveContext,
  ResolveResult,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { pushQueueConclusion } from "../conclusions";

// ─── Resolve (Launcher) ──────────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  if (!ctx.workItemId) return undefined;

  // Fetch the defect
  const { raw: defect } = await ctx.utils.fetchWorkItem(ctx.workItemId);

  // Discover the PR via the shared utility
  const prResult = await ctx.utils.discoverPR(defect);
  if (!prResult) return undefined; // agent fallback

  const { pr } = prResult;
  const parts = ctx.args.split(/\s+/);
  const baseBranch = parts[1] || pr.targetBranch || "staging";

  return {
    branchName: pr.sourceBranch,
    baseBranch,
    workerArgs: ctx.workItemId,
    reuseExisting: true, // PR branch already exists
    sideEffects: async () => {
      // Move defect to In-Progress (best-effort)
      try {
        await ctx.utils
          .$`az boards work-item update --id ${ctx.workItemId} --state In-Progress`
          .quiet()
          .nothrow();
      } catch {
        /* non-fatal */
      }
    },
  };
};

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  if (!ctx.workItemId) {
    return {
      userMessage: `Fix defect: ${ctx.args}`,
      templateVars: {
        DEFECT_CONTEXT: "No defect ID provided.",
        PARENT_CONTEXT: "",
        PR_CONTEXT: "",
        PR_COMMENTS: "",
        MEDIA_CONTEXT: "",
        DEFECT_ID: "",
        PR_ID: "",
        TARGET_BRANCH: "staging",
        REMAINING_WORK: "unknown",
      },
    };
  }

  // Fetch defect
  const { formatted: defectCtx, raw: defect } =
    await ctx.utils.fetchWorkItem(ctx.workItemId);

  // Fetch parent work item
  let parentCtx = "> No parent work item found.";
  const parentRel = defect.relations?.find(
    (r: any) => r.relation === "Parent",
  );
  if (parentRel) {
    try {
      const { formatted } = await ctx.utils.fetchWorkItem(
        String(parentRel.id),
      );
      parentCtx = formatted;
    } catch {
      parentCtx = "> Failed to fetch parent work item.";
    }
  }

  // Discover PR + comments
  let prCtx = "> No linked PR found.";
  let commentsCtx = "> No active PR review threads.";
  let prId = "";
  let targetBranch = "staging";

  const prResult = await ctx.utils.discoverPR(defect);
  if (prResult) {
    prId = prResult.prId;
    targetBranch = prResult.pr.targetBranch || "staging";
    try {
      prCtx = await ctx.utils.formatPR(prId);
    } catch {
      prCtx = `> Failed to fetch PR #${prId}.`;
    }
    try {
      commentsCtx = await ctx.utils.fetchPRComments(prId);
    } catch {
      commentsCtx = "> Failed to fetch PR comments.";
    }
  }

  // Process media from defect fields + attachments
  const media = await ctx.utils.processMedia(
    defect.fields || {},
    defect.attachments,
  );

  // RemainingWork
  const remaining =
    defect.fields?.["Microsoft.VSTS.Scheduling.RemainingWork"];
  // RemainingWork is stored in work days — convert to hours (1 day = 8h)
  const remainingStr =
    remaining != null ? String(Number(remaining) * 8) : "unknown";

  return {
    userMessage: ctx.utils.generateUserMessage(
      "fix-defect",
      defect,
      ctx.workItemId,
      ctx.args,
    ),
    templateVars: {
      DEFECT_CONTEXT: defectCtx,
      PARENT_CONTEXT: parentCtx,
      PR_CONTEXT: prCtx,
      PR_COMMENTS: commentsCtx,
      MEDIA_CONTEXT: media,
      DEFECT_ID: ctx.workItemId,
      PR_ID: prId,
      TARGET_BRANCH: targetBranch,
      REMAINING_WORK: remainingStr,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const defectWorkflow: WorkflowDefinition = {
  name: "fix-defect",
  description: "Fix a defect linked to an existing PR",
  requiredTools: ["work-item", "get-pr", "pr-comments"],
  workerTemplate: "worker.md",
  launcherTemplate: "launcher.md",
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  agent: {
    name: "defect-worker",
    model: "opencode/claude-opus-4-6",
    mode: "all",
    description:
      "Autonomous worker for fixing defects in isolated worktrees",
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
