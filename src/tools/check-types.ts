import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { stripAnsi } from "../utils";

export function createCheckTypesTool(
  config: DevToolsConfig,
  root: string,
  $: any,
) {
  const cfg = config.checkTypes;

  return ["check-types", tool({
    description:
      "Run TypeScript type checking on the project. " +
      "Returns errors found or confirms no errors. " +
      (cfg.branchCommand
        ? "Use branchOnly for faster incremental checks (only packages changed on current branch)."
        : ""),
    args: {
      compact: tool.schema.optional(tool.schema.boolean()),
      branchOnly: tool.schema.optional(tool.schema.boolean()),
    },
    async execute(args) {
      const compact = args.compact !== false; // default true
      const useBranch = args.branchOnly && cfg.branchCommand;
      const mode = useBranch ? "branch" : "full";

      try {
        const envWithBin = {
          ...process.env,
          PATH: `${root}/node_modules/.bin:${process.env.PATH}`,
        };

        let result;
        if (useBranch) {
          const branchArgs = cfg.branchArgs ?? [];
          result = await $`cd ${root} && ${cfg.branchCommand} ${branchArgs} 2>&1`
            .env(envWithBin)
            .nothrow()
            .quiet();
        } else {
          result =
            await $`cd ${root} && ${cfg.command} ${cfg.args} 2>&1`.nothrow().quiet();
        }

        const output = stripAnsi(result.stdout.toString());

        if (result.exitCode === 0) {
          const pkgMatch = output.match(
            /(\d+) packages? ran check-types successfully/,
          );
          const count = pkgMatch ? ` (${pkgMatch[1]} packages)` : "";
          return `Type check passed${count}. No errors found. [${mode}]`;
        }

        // Type errors — parse and format
        const lines = output.split("\n");

        if (compact) {
          const errors: string[] = [];
          const seen = new Set<string>();

          for (const line of lines) {
            const tsMatch = line.match(
              /([^(\s]+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/,
            );
            const tscMatch = line.match(
              /([^:\s]+):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)/,
            );
            const m = tsMatch || tscMatch;
            if (m) {
              const key = `${m[1]}:${m[2]} ${m[4]}`;
              if (!seen.has(key)) {
                seen.add(key);
                errors.push(`${m[1]}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`);
              }
            }
          }

          if (errors.length > 0) {
            return [
              `Type check FAILED: ${errors.length} error${errors.length > 1 ? "s" : ""} [${mode}]`,
              "",
              ...errors.slice(0, cfg.maxErrors),
            ].join("\n");
          }
        }

        // Non-compact or no TS errors matched
        const meaningful = lines.filter(
          (l: string) =>
            l.includes("error TS") ||
            l.includes("Error:") ||
            l.includes("FAIL") ||
            l.startsWith("error") ||
            l.trim() === "",
        );

        return [
          `Type check FAILED (exit code: ${result.exitCode}) [${mode}]`,
          "",
          ...(meaningful.length > 5
            ? meaningful.slice(0, cfg.maxLines)
            : lines.slice(-100)),
        ].join("\n");
      } catch (e: any) {
        return `Type check execution error: ${e.message}`;
      }
    },
  })] as const;
}
