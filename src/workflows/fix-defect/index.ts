/**
 * Defect Workflow — Fix defects in isolated worktrees.
 *
 * Branching: Creates `dev/<id>-<slug>` from the parent work item's
 * branch (looked up in the branch registry). Falls back to launcher
 * mode if no registry entry is found, prompting the user for a branch.
 *
 * Launcher: /fix-defect <defectId> [baseBranch]
 * Worker: receives context via /workflow-run fix-defect <defectId>
 */

import type {
  WorkflowDefinition,
  ResolveContext,
  ResolveResult,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { pushQueueConclusion } from "../conclusions";
import { TESTING_GUIDANCE } from "../shared/testing-guidance";
import { afterWriteTypeCheckAndTest } from "../shared/after-write";
import { deriveDevBranch } from "../shared/branch-utils";
import { getEntry, setEntry } from "../../branch-registry";

// ─── Resolve (Launcher) ──────────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  if (!ctx.workItemId) return undefined;

  // Fetch the defect
  let defect: any;
  try {
    const result = await ctx.utils.fetchWorkItem(ctx.workItemId);
    defect = result.raw;
  } catch {
    // Can't fetch work item — fall back to agent mode
    return undefined;
  }

  // Determine baseBranch: explicit arg > parent registry lookup
  const parts = ctx.args.split(/\s+/);
  let baseBranch: string | undefined = parts[1] || undefined;

  if (!baseBranch) {
    // Look up parent work item's branch in the registry
    const parentRel = defect.relations?.find(
      (r: any) => r.relation === "Parent",
    );
    if (parentRel) {
      const entry = getEntry(String(parentRel.id));
      if (entry) {
        baseBranch = entry.branch;
      }
    }
  }

  // If still no baseBranch, fall back to agent mode (launcher asks user)
  if (!baseBranch) return undefined;

  // Derive branch name: dev/<id>-<slug>
  const branchName = deriveDevBranch(defect);

  // Register in branch registry
  setEntry(ctx.workItemId, {
    branch: branchName,
    targetBranch: baseBranch,
    workflow: "fix-defect",
    createdAt: new Date().toISOString(),
  });

  return {
    branchName,
    baseBranch,
    workerArgs: ctx.workItemId,
    reuseExisting: false,
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
  // Extract baseBranch from args or default
  const parts = ctx.args.split(/\s+/);
  const baseBranch = parts[1] || "staging";

  if (!ctx.workItemId) {
    return {
      userMessage: `Fix defect: ${ctx.args}`,
      templateVars: {
        DEFECT_CONTEXT: "No defect ID provided.",
        PARENT_CONTEXT: "",
        MEDIA_CONTEXT: "",
        DEFECT_ID: "",
        TARGET_BRANCH: baseBranch,
        REMAINING_WORK: "unknown",
        TESTING_GUIDANCE: TESTING_GUIDANCE,
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

  // Resolve TARGET_BRANCH: prefer registry entry (set by resolve),
  // then explicit arg, then fall back to staging
  let targetBranch = baseBranch;
  if (parentRel) {
    const entry = getEntry(String(parentRel.id));
    if (entry) {
      targetBranch = entry.branch;
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
      MEDIA_CONTEXT: media,
      DEFECT_ID: ctx.workItemId,
      TARGET_BRANCH: targetBranch,
      REMAINING_WORK: remainingStr,
      TESTING_GUIDANCE: TESTING_GUIDANCE,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const defectWorkflow: WorkflowDefinition = {
  name: "fix-defect",
  description: "Fix a defect in an isolated worktree",
  requiredTools: ["work-item", "generate"],
  workerTemplate: "worker.md",
  launcherTemplate: "launcher.md",
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  injectAfterWrite: [afterWriteTypeCheckAndTest],
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
