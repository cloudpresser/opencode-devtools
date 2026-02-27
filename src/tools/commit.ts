import { tool } from "@opencode-ai/plugin";

// Strip ANSI escape codes from terminal output
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// Truncate verbose hook output to just the key error lines
function summarizeHookError(stderr: string, maxLines = 30): string {
  const clean = stripAnsi(stderr).trim();
  const lines = clean.split("\n");
  if (lines.length <= maxLines) return clean;
  return [
    ...lines.slice(0, maxLines),
    "",
    `... (${lines.length - maxLines} more lines truncated)`,
  ].join("\n");
}

export function createCommitTool(_config: any, _root: string, $: any) {
  return [
    "commit",
    tool({
      description:
        "Stage files and create a git commit. Combines `git add` and " +
        "`git commit` into a single tool call with clean, summarized output. " +
        "Use `skipHooks: true` for red commits where tests intentionally fail.",
      args: {
        message: tool.schema.string().describe("Commit message (conventional format)"),
        workdir: tool.schema.string().describe("Absolute path to the worktree directory"),
        files: tool.schema
          .optional(tool.schema.array(tool.schema.string()))
          .describe('Paths to stage, relative to workdir. Defaults to ["."] (all changes)'),
        skipHooks: tool.schema
          .optional(tool.schema.boolean())
          .describe("Skip pre-commit hooks (for red commits with intentionally failing tests)"),
      },
      async execute(args) {
        const { message, workdir, skipHooks } = args;
        const files = args.files ?? ["."];

        // 1. Check for changes
        let status: string;
        try {
          status = (
            await $`git -C ${workdir} status --porcelain`.text()
          ).trim();
        } catch (e: any) {
          return `Failed to check git status: ${e.message}`;
        }

        if (!status) {
          return "No changes to commit.";
        }

        // 2. Stage files
        try {
          for (const f of files) {
            await $`git -C ${workdir} add ${f}`.quiet();
          }
        } catch (e: any) {
          return `Failed to stage files: ${e.message}`;
        }

        // 3. Commit
        const commitArgs = ["commit", "-m", message];
        if (skipHooks) {
          commitArgs.push("--no-verify");
        }

        try {
          const result = await $`git -C ${workdir} ${commitArgs}`
            .nothrow()
            .quiet();

          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString();
            const stdout = result.stdout.toString();
            const combined = (stderr + "\n" + stdout).trim();

            if (!combined) {
              return "Commit failed with no output. Check the worktree state with `git status`.";
            }

            return [
              "Commit failed (pre-commit hook or other error):",
              "",
              summarizeHookError(combined),
            ].join("\n");
          }
        } catch (e: any) {
          return `Commit failed: ${e.message}`;
        }

        // 4. Build clean summary
        try {
          const sha = (
            await $`git -C ${workdir} log -1 --format=%h`.text()
          ).trim();
          const diffStat = (
            await $`git -C ${workdir} diff --stat HEAD~1..HEAD`.text()
          ).trim();

          // Extract the summary line (last line of diff --stat)
          const statLines = diffStat.split("\n");
          const summary = statLines[statLines.length - 1]?.trim() ?? "";

          return `Committed ${sha}: ${message} (${summary})`;
        } catch {
          // Commit succeeded but summary failed — still report success
          return `Committed: ${message}`;
        }
      },
    }),
  ] as const;
}
