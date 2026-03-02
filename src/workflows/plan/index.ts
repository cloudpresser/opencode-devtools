/**
 * Plan Workflow — Break down work items into sub-tasks.
 *
 * Direct command: /plan <workItemId>
 * Runs in the current session (no worktree, no worker agent).
 *
 * Replaces the old superior-workflow command.
 */

import type {
  WorkflowDefinition,
  WorkflowParam,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { parseWorkItemId } from "../types";
import { noneConclusion } from "../conclusions";

// ─── Params ──────────────────────────────────────────────────────────────────

const params: WorkflowParam[] = [
  { name: "workItemId", required: true, description: "Work item ID or URL" },
];

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  const workItemId = parseWorkItemId(ctx.params.workItemId);

  if (!workItemId) {
    return {
      userMessage: "Plan: no work item ID provided",
      templateVars: {
        WORK_ITEM_CONTEXT: "No work item ID provided. Please provide a work item ID to plan.",
        MEDIA_CONTEXT: "",
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

  return {
    userMessage: ctx.utils.generateUserMessage(
      "plan",
      workItem,
      workItemId,
      Object.values(ctx.params).filter(Boolean).join(" "),
    ),
    templateVars: {
      WORK_ITEM_CONTEXT: formatted,
      MEDIA_CONTEXT: media,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const planWorkflow: WorkflowDefinition = {
  name: "plan",
  description: "Break down a work item into sub-tasks",
  requiredTools: ["work-item"],
  workerTemplate: "plan.md",
  params,
  usesWorktree: false,
  injectWorkerContext,
  conclusion: noneConclusion,
  __dirname: import.meta.dir,
};
