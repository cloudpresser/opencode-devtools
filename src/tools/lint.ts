import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { stripAnsi } from "../utils";

export function createLintTool(config: DevToolsConfig, root: string, $: any) {
  const cfg = config.lint;

  return ["lint", tool({
    description:
      "Run the linter on the project. By default lints only files changed since last commit. " +
      "Returns errors found or confirms no errors.",
    args: {
      all: tool.schema.optional(tool.schema.boolean()),
      staged: tool.schema.optional(tool.schema.boolean()),
      fix: tool.schema.optional(tool.schema.boolean()),
    },
    async execute(args) {
      const lintArgs = [...cfg.args];
      if (args.all) lintArgs.push("--all");
      if (args.staged) lintArgs.push("--staged");
      if (args.fix) lintArgs.push("--fix");

      try {
        const result =
          await $`cd ${root} && ${cfg.command} ${lintArgs} 2>&1`.nothrow().quiet();
        const output = stripAnsi(result.stdout.toString());
        const exitCode = result.exitCode;

        if (exitCode === 0) {
          if (output.includes("No TypeScript/JavaScript files to lint")) {
            return "Lint passed. No files to lint.";
          }
          return "Lint passed. No errors found.";
        }

        // Parse ESLint output for compact summary
        const lines = output.split("\n");
        const problemMatch = output.match(
          /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/,
        );

        if (problemMatch) {
          const meaningful = lines.filter(
            (l: string) =>
              l.startsWith("/") ||
              l.match(/^\s+\d+:\d+/) ||
              l.match(/^\u2716/) ||
              l.trim() === "",
          );
          return [
            `Lint FAILED: ${problemMatch[1]} problems (${problemMatch[2]} errors, ${problemMatch[3]} warnings)`,
            "",
            ...meaningful.slice(0, cfg.maxLines),
          ].join("\n");
        }

        // Fallback: return raw output (trimmed)
        return output.slice(0, 10_000);
      } catch (e: any) {
        return `Lint execution error: ${e.message}`;
      }
    },
  })] as const;
}
