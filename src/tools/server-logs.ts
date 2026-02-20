import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import type { SessionManager } from "../session-manager";
import { stripAnsi, ERROR_FILTER } from "../utils";

export function createServerLogsTool(
  config: DevToolsConfig,
  manager: SessionManager,
) {
  // Build title map from server configs, with short aliases
  const titleMap: Record<string, string> = {};
  for (const [key, serverCfg] of Object.entries(config.devServer.servers)) {
    titleMap[key] = serverCfg.title;
  }

  const serverNames = Object.keys(titleMap);

  // Resolve server name including short aliases (e.g. "next" -> "nextjs")
  const resolveServer = (name: string): string | undefined => {
    if (titleMap[name]) return name;
    const match = serverNames.find((k) => k.startsWith(name));
    return match;
  };

  return [
    "server-logs",
    tool({
      description:
        "Get logs from a running dev server. " +
        "The dev server must have been started with the dev-server_start tool. " +
        "Supports regex filtering, pagination (offset + lineCount), and verbose mode. " +
        "Use errorsOnly to filter to error/warning lines." +
        (serverNames.length > 0
          ? ` Available servers: ${serverNames.join(", ")}. Short prefixes also work (e.g. "next" for "nextjs").`
          : ""),
      args: {
        server: tool.schema.string(),
        pattern: tool.schema.optional(tool.schema.string()),
        offset: tool.schema.optional(tool.schema.number()),
        lineCount: tool.schema.optional(tool.schema.number()),
        verbose: tool.schema.optional(tool.schema.boolean()),
        errorsOnly: tool.schema.optional(tool.schema.boolean()),
      },
      async execute(args) {
        const resolved = resolveServer(args.server);
        if (!resolved) {
          return `Unknown server "${args.server}". Available: ${serverNames.join(", ")}`;
        }
        const title = titleMap[resolved];

        const session = manager.findByTitle(title);
        if (!session) {
          return `No running ${args.server} dev server found. Start one with dev-server_start first.`;
        }

        const filterPattern = args.errorsOnly
          ? ERROR_FILTER.source
          : args.pattern;

        const limit = args.lineCount ?? config.serverLogs.defaultLineCount;
        const offset = args.offset ?? 0;
        const result = manager.readBuffer(session.id, {
          offset,
          limit,
          pattern: filterPattern,
        });

        if (!result) return "Session not found.";

        let lines = result.lines;
        if (!args.verbose) {
          lines = lines
            .map(stripAnsi)
            .filter((l: string) => l.trim().length > 0);
        }

        if (args.errorsOnly && lines.length === 0) {
          return `No errors found in ${args.server} server output.`;
        }

        const header = [
          `=== ${title} Logs${args.errorsOnly ? " (errors only)" : ""} ===`,
          `Session: ${session.id} | Status: ${session.status}`,
          `Lines: ${offset + 1}-${offset + lines.length} of ${result.totalLines}`,
          filterPattern
            ? `Filter: /${filterPattern}/ (${result.matchedLines} matches)`
            : "",
          "---",
        ]
          .filter(Boolean)
          .join("\n");

        const numbered = lines
          .map(
            (l: string, i: number) =>
              `${String(offset + i + 1).padStart(5)} | ${l}`,
          )
          .join("\n");

        const remaining = result.matchedLines - offset - lines.length;
        const footer =
          remaining > 0
            ? `\n--- ${remaining} more lines. Use offset=${offset + lines.length} to continue.`
            : "";

        return header + "\n" + numbered + footer;
      },
    }),
  ] as const;
}
