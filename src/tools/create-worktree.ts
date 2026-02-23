import { tool } from "@opencode-ai/plugin";
import { join } from "node:path";
import { readFileSync, existsSync, symlinkSync } from "node:fs";
import type { DevToolsConfig } from "../config";

export function createWorktreeTool(
  _config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "create-worktree",
    tool({
      description:
        "Create a git worktree for a branch and set up node_modules. " +
        "Returns the absolute worktree path. Automatically detects bare " +
        "vs regular repos and symlinks node_modules if lockfiles match, " +
        "or runs yarn install if they differ.",
      args: {
        branchName: tool.schema.string(),
        baseBranch: tool.schema.string(),
        worktreeRoot: tool.schema.optional(tool.schema.string()),
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

        // 2. Create worktree
        try {
          const result =
            await $`git -C ${root} worktree add ${worktreeDir} -b ${args.branchName} ${args.baseBranch}`
              .nothrow()
              .quiet();

          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim();
            return `Failed to create worktree: ${stderr || "unknown error"}`;
          }
        } catch (e: any) {
          return `Failed to create worktree: ${e.message}`;
        }

        // 3. Symlink or install node_modules
        const sessionLock = join(root, "yarn.lock");
        const worktreeLock = join(worktreeDir, "yarn.lock");
        const sessionNodeModules = join(root, "node_modules");
        const worktreeNodeModules = join(worktreeDir, "node_modules");

        let depsStatus: string;
        try {
          if (!existsSync(sessionNodeModules)) {
            depsStatus =
              "no node_modules in session directory — run yarn install manually";
          } else if (existsSync(sessionLock) && existsSync(worktreeLock)) {
            const sessionLockContent = readFileSync(sessionLock);
            const worktreeLockContent = readFileSync(worktreeLock);

            if (sessionLockContent.equals(worktreeLockContent)) {
              symlinkSync(sessionNodeModules, worktreeNodeModules);
              depsStatus = "node_modules symlinked (lockfiles match)";
            } else {
              await $`cd ${worktreeDir} && yarn install`.quiet();
              depsStatus = "yarn install completed (lockfiles differ)";
            }
          } else {
            // No lockfile comparison possible — symlink optimistically
            symlinkSync(sessionNodeModules, worktreeNodeModules);
            depsStatus =
              "node_modules symlinked (no lockfile comparison available)";
          }
        } catch (e: any) {
          depsStatus = `Failed to set up dependencies: ${e.message}. Run yarn install manually in the worktree.`;
        }

        return [
          `Worktree created at: ${worktreeDir}`,
          `Branch: ${args.branchName} (from ${args.baseBranch})`,
          `Dependencies: ${depsStatus}`,
          "",
          "Use this absolute path for all subsequent file operations.",
        ].join("\n");
      },
    }),
  ] as const;
}
