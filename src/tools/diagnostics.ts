import { tool } from "@opencode-ai/plugin";
import type { Logger } from "../logger";

export function createDiagnosticsTool(
  logger: Logger,
  getState: () => {
    workerSessions: string[];
    registeredTools: string[];
    config: Record<string, unknown>;
  },
) {
  return [
    "devtools-diagnostics",
    tool({
      description:
        "Retrieve opencode-devtools plugin logs and runtime state. " +
        "Use this to debug tool registration, hook behavior, config " +
        "loading, and agent tracking issues.",
      args: {
        tail: tool.schema
          .optional(tool.schema.number())
          .describe("Number of recent log lines to return (default 50)"),
        filter: tool.schema
          .optional(tool.schema.string())
          .describe(
            "Filter log lines by substring (e.g. 'config', 'hook', 'worktree', a sessionID)",
          ),
        state: tool.schema
          .optional(tool.schema.boolean())
          .describe("Include current plugin runtime state"),
      },
      async execute(args) {
        const sections: string[] = [];

        // Log lines
        const lines = logger.getRecent(args.tail ?? 50, args.filter);
        if (lines.length > 0) {
          sections.push(`## Recent Logs (${lines.length} lines)`);
          sections.push("```");
          sections.push(lines.join("\n"));
          sections.push("```");
        } else {
          sections.push("## Recent Logs");
          sections.push("No log entries found.");
        }
        sections.push(`Log file: ${logger.logFile}`);

        // Runtime state
        if (args.state) {
          const s = getState();
          sections.push("");
          sections.push("## Runtime State");
          sections.push(
            `**Worker sessions:** ${s.workerSessions.length > 0 ? s.workerSessions.join(", ") : "(none)"}`,
          );
          sections.push(
            `**Registered tools:** ${s.registeredTools.join(", ")}`,
          );
          sections.push(
            `**Config:** ${JSON.stringify(s.config, null, 2)}`,
          );
        }

        return sections.join("\n");
      },
    }),
  ] as const;
}
