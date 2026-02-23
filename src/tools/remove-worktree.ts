import { tool } from "@opencode-ai/plugin";
import { join } from "node:path";
import type { DevToolsConfig } from "../config";

export function createRemoveWorktreeTool(
  _config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "remove-worktree",
    tool({
      description:
        "Remove a git worktree. Does not delete the branch. " +
        "Use force to remove even with uncommitted changes.",
      args: {
        branchName: tool.schema.string(),
        worktreeRoot: tool.schema.optional(tool.schema.string()),
        force: tool.schema.optional(tool.schema.boolean()),
      },
      async execute(args) {
        // 1. Determine worktree root
        let worktreeRoot = args.worktreeRoot;
        if (!worktreeRoot) {
          let isBare = false;
          try {
            const result =
              await $`git -C ${root} rev-parse --is-bare-repository`.text();
            isBare = result.trim() === "true";
          } catch {
            // default non-bare
          }
          worktreeRoot = isBare ? root : join(root, "..");
        }

        const worktreeDir = join(worktreeRoot, args.branchName);

        // 2. Remove worktree
        try {
          const result = args.force
            ? await $`git -C ${root} worktree remove ${worktreeDir} --force`
                .nothrow()
                .quiet()
            : await $`git -C ${root} worktree remove ${worktreeDir}`
                .nothrow()
                .quiet();

          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim();
            return `Failed to remove worktree: ${stderr || "unknown error"}. Use force=true to remove with uncommitted changes.`;
          }
        } catch (e: any) {
          return `Failed to remove worktree: ${e.message}. Use force=true to remove with uncommitted changes.`;
        }

        return [
          `Worktree removed: ${worktreeDir}`,
          `Branch "${args.branchName}" was preserved.`,
        ].join("\n");
      },
    }),
  ] as const;
}
