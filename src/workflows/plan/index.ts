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
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { noneConclusion } from "../conclusions";

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  if (!ctx.workItemId) {
    return {
      userMessage: `Plan: ${ctx.args}`,
      templateVars: {
        WORK_ITEM_CONTEXT: "No work item ID provided. Please provide a work item ID to plan.",
        MEDIA_CONTEXT: "",
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

  return {
    userMessage: ctx.utils.generateUserMessage(
      "plan",
      workItem,
      ctx.workItemId,
      ctx.args,
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
  usesWorktree: false, // runs in current session
  injectWorkerContext,
  conclusion: noneConclusion,
  __dirname: import.meta.dir,
};
