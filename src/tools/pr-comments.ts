import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { getProvider } from "../providers";
import type { PrCommentThread } from "../providers/types";

function formatThread(thread: PrCommentThread, index: number): string {
  const lines: string[] = [];

  const statusIcon: Record<string, string> = {
    active: "!",
    fixed: "v",
    closed: "-",
    wontFix: "-",
    byDesign: "-",
    pending: "?",
    unknown: " ",
  };

  const icon = statusIcon[thread.status] || statusIcon.unknown;
  lines.push(`### ${index + 1}. [${icon}] ${thread.status}`);

  if (thread.filePath) {
    const location = thread.line
      ? `${thread.filePath}:${thread.line}`
      : thread.filePath;
    lines.push(`**File:** ${location}`);
  }

  for (const comment of thread.comments) {
    const date = comment.date
      ? new Date(comment.date).toLocaleDateString()
      : "";
    lines.push(`**${comment.author}** ${date}`);
    lines.push(comment.content);
  }

  return lines.join("\n");
}

export function createPrCommentsTool(
  config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "pr-comments",
    tool({
      description:
        "Fetch and display PR comments/review threads. Returns comment threads with author, content, file location, and resolution status. Use --active-only to see only unresolved threads. Accepts a PR ID number. Pass provider to override the global setting (e.g. 'github' or 'azure-devops').",
      args: {
        id: tool.schema.string(),
        activeOnly: tool.schema.optional(tool.schema.boolean()),
        provider: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        try {
          const effectiveConfig = args.provider
            ? { ...config, provider: args.provider }
            : config;
          const provider = getProvider(effectiveConfig.provider);

          const activeOnly =
            args.activeOnly ?? config.prComments?.activeOnly ?? false;

          let threads = await provider.fetchPrComments(
            args.id,
            effectiveConfig,
            root,
            $,
          );

          if (activeOnly) {
            threads = threads.filter((t) => t.status === "active");
          }

          if (threads.length === 0) {
            return activeOnly
              ? "No active comment threads found."
              : "No comment threads found.";
          }

          const active = threads.filter((t) => t.status === "active").length;
          const resolved = threads.filter(
            (t) => t.status === "fixed" || t.status === "closed",
          ).length;

          const prNumber =
            args.id.match(/\/pull\/(\d+)/)?.[1] ||
            args.id.match(/pullrequest[s]?\/(\d+)/i)?.[1] ||
            args.id.match(/^\d+$/)?.[0] ||
            args.id;
          const header = `## PR #${prNumber} Comments\n\n**${threads.length}** threads (${active} active, ${resolved} resolved)\n\n---`;
          const body = threads.map(formatThread).join("\n\n---\n\n");

          return `${header}\n\n${body}`;
        } catch (error) {
          return `Error fetching PR comments: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),
  ] as const;
}
