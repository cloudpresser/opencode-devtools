import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";
import { getProvider } from "../providers/registry";

export function createWorkItemCommentTool(
  config: DevToolsConfig,
  root: string,
  $: any,
  log: Logger = noopLogger,
) {
  return [
    "work-item-comment",
    tool({
      description:
        "Post a comment on an Azure DevOps / GitHub work item. Use this to " +
        "document findings, report blockers, or provide status updates on " +
        "work items during the workflow.",
      args: {
        workItemId: tool.schema
          .string()
          .describe("Work item ID (e.g. '71405') or full URL"),
        text: tool.schema
          .string()
          .describe("Comment text to post (supports HTML formatting)"),
      },
      async execute(args) {
        const provider = getProvider(config.provider);
        const truncatedText =
          args.text.length > 120
            ? args.text.slice(0, 120) + "..."
            : args.text;
        log.info(
          "work-item-comment",
          `Posting comment on ${args.workItemId}: ${truncatedText}`,
        );

        if (!provider.addWorkItemComment) {
          return `The ${config.provider} provider does not support adding work item comments.`;
        }

        try {
          const result = await provider.addWorkItemComment(
            args.workItemId,
            args.text,
            config.workItem,
            root,
            $,
          );
          log.info(
            "work-item-comment",
            `Comment posted successfully (ID: ${result.commentId})`,
          );
          return `Comment posted successfully (ID: ${result.commentId}).`;
        } catch (e: any) {
          log.error(
            "work-item-comment",
            `Failed to post comment on ${args.workItemId}: ${e.message}`,
          );
          return `Failed to post comment on work item ${args.workItemId}: ${e.message}`;
        }
      },
    }),
  ] as const;
}
