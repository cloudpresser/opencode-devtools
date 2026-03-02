/**
 * Defect Workflow — Fix defects in isolated worktrees.
 *
 * Branching: Creates `dev/<id>-<slug>` from the parent work item's
 * branch (looked up in the branch registry), or from an explicit
 * baseBranch argument. CLI exits with error if no branch is resolvable.
 *
 * CLI: devtools fix-defect <defectId> [baseBranch]
 * Agent bootstraps via: /fix-defect <defectId>
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
import { getEntry, setEntry } from "../../branch-registry";

// ─── Params ──────────────────────────────────────────────────────────────────

const params: WorkflowParam[] = [
  { name: "defectId", required: true, description: "Defect work item ID or URL" },
  { name: "baseBranch", required: false, description: "Branch to create worktree from (auto-detected from parent)" },
];

// ─── Resolve (CLI pre-launch) ────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  const defectId = parseWorkItemId(ctx.params.defectId);
  if (!defectId) return undefined;

  // Fetch the defect — let errors propagate so the CLI can surface them
  const { raw: defect } = await ctx.utils.fetchWorkItem(defectId);

  // Determine baseBranch: explicit arg > parent registry lookup
  let baseBranch: string | undefined = ctx.params.baseBranch;

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

  if (!baseBranch) return undefined;

  // Derive branch name: dev/<id>-<slug>
  const branchName = deriveDevBranch(defect);

  // Register in branch registry
  setEntry(defectId, {
    branch: branchName,
    targetBranch: baseBranch,
    workflow: "fix-defect",
    createdAt: new Date().toISOString(),
  });

  return {
    branchName,
    baseBranch,
    workerArgs: defectId,
    reuseExisting: false,
    sideEffects: async () => {
      // Move defect to In-Progress (best-effort)
      try {
        await ctx.utils
          .$`az boards work-item update --id ${defectId} --state In-Progress`
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
  const defectId = parseWorkItemId(ctx.params.defectId);
  const baseBranch = ctx.params.baseBranch || "staging";

  if (!defectId) {
    return {
      userMessage: "Fix defect: no defect ID provided",
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
    await ctx.utils.fetchWorkItem(defectId);

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
      defectId,
      Object.values(ctx.params).filter(Boolean).join(" "),
    ),
    templateVars: {
      DEFECT_CONTEXT: defectCtx,
      PARENT_CONTEXT: parentCtx,
      MEDIA_CONTEXT: media,
      DEFECT_ID: defectId,
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
  params,
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  injectAfterWrite: [afterWriteTypeCheckAndTest],
  agent: {
    name: "fix-defect",
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
