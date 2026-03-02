/**
 * Merge-Rebase Workflow — Update PR branches with latest staging.
 *
 * Direct command: /merge-rebase <branch>
 * Runs in the current session (no worktree, no worker agent).
 */

import type {
  WorkflowDefinition,
  WorkflowParam,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { directPushConclusion } from "../conclusions";

// ─── Params ──────────────────────────────────────────────────────────────────

const params: WorkflowParam[] = [
  { name: "branch", required: true, description: "PR branch to update" },
];

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => ({
  userMessage: `Merge staging into ${ctx.params.branch} and verify no regressions`,
  templateVars: {
    BRANCH: ctx.params.branch || "",
  },
});

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const mergeRebaseWorkflow: WorkflowDefinition = {
  name: "merge-rebase",
  description: "Update PR branch with latest staging",
  requiredTools: ["check-types", "lint", "run-tests"],
  workerTemplate: "worker.md",
  params,
  usesWorktree: false,
  injectWorkerContext,
  conclusion: directPushConclusion,

  injectAfterWrite: [
    async (ctx) => {
      // After conflict resolution edits, check for remaining merge markers
      const contents = await Promise.all(
        ctx.filePaths.map((f) =>
          Bun.file(f)
            .text()
            .catch(() => ""),
        ),
      );
      const hasMarkers = contents.some((c) => /^[<>=]{7}/m.test(c));
      if (!hasMarkers) return undefined;
      return "\n--- Warning: Merge conflict markers still present in edited files ---";
    },
  ],

  __dirname: import.meta.dir,
};
