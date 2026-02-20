import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { stripAnsi } from "../utils";

export function createGenerateTool(
  config: DevToolsConfig,
  root: string,
  $: any,
) {
  const cfg = config.generate;
  const templateList = cfg.templates?.length
    ? ` Available templates: ${cfg.templates.join(", ")}.`
    : "";

  return ["generate", tool({
    description:
      "Run the project code generator. " +
      "Use this to scaffold new features, views, models, queries, mutations, or other components." +
      templateList,
    args: {
      template: tool.schema.string(),
      name: tool.schema.string(),
      parent: tool.schema.optional(tool.schema.string()),
      isStreaming: tool.schema.optional(tool.schema.boolean()),
    },
    async execute(args) {
      const cmdArgs = [
        ...cfg.args,
        "--template",
        args.template,
        "--name",
        args.name,
      ];
      if (args.parent) cmdArgs.push("--parent", args.parent);
      if (args.isStreaming !== undefined)
        cmdArgs.push("--isStreaming", String(args.isStreaming));

      try {
        const result =
          await $`cd ${root} && ${cfg.command} ${cmdArgs} 2>&1`.nothrow().quiet();
        const output = stripAnsi(result.stdout.toString());
        const exitCode = result.exitCode;

        if (exitCode === 0) {
          const lines = output.split("\n");
          const generated = lines.filter(
            (l: string) =>
              l.includes("Generated") ||
              l.includes("created") ||
              l.includes("Created") ||
              l.includes("packages/") ||
              l.includes("apps/") ||
              l.includes("Successfully"),
          );

          if (generated.length > 0) {
            return [
              `Generator completed: ${args.template} "${args.name}"`,
              "",
              ...generated,
            ].join("\n");
          }

          const meaningful = lines
            .filter(
              (l: string) =>
                l.trim().length > 0 &&
                !l.includes("yarn ") &&
                !l.includes("$ tensor") &&
                !l.includes("Done in"),
            )
            .slice(-20);

          return [
            `Generator completed: ${args.template} "${args.name}"`,
            "",
            ...meaningful,
          ].join("\n");
        }

        return [
          `Generator FAILED (exit code: ${exitCode}): ${args.template} "${args.name}"`,
          "",
          output.slice(0, 5_000),
        ].join("\n");
      } catch (e: any) {
        return `Generator execution error: ${e.message}`;
      }
    },
  })] as const;
}
