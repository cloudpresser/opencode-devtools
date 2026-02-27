/**
 * Register Branch Tool — Registers a work item → branch mapping
 * in the persistent branch registry.
 *
 * Used by the plan workflow agent after creating feature/bug branches.
 * Implement and fix-defect workflows register branches programmatically
 * via their resolve functions.
 */

import { tool } from "@opencode-ai/plugin";
import { setEntry } from "../branch-registry";

export function createRegisterBranchTool() {
  return [
    "register-branch",
    tool({
      description:
        "Register a work item → branch mapping in the branch registry. " +
        "Use this after creating a feature or bug branch to enable " +
        "automatic branch targeting for sub-task workflows.",
      args: {
        workItemId: tool.schema
          .string()
          .describe("Work item ID (e.g. '70000')"),
        branch: tool.schema
          .string()
          .describe(
            "Branch name (e.g. 'feature/70000-add-dark-mode')",
          ),
        targetBranch: tool.schema
          .string()
          .describe(
            "What this branch targets (e.g. 'staging')",
          ),
      },
      async execute(args) {
        setEntry(args.workItemId, {
          branch: args.branch,
          targetBranch: args.targetBranch,
          workflow: "plan",
          createdAt: new Date().toISOString(),
        });
        return `Registered: #${args.workItemId} → ${args.branch} (targets ${args.targetBranch})`;
      },
    }),
  ] as const;
}
