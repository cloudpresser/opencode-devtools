import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { getProvider } from "../providers";
import type { CreatePrResult } from "../providers";

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createPrTool(config: DevToolsConfig, root: string, $: any) {
  const cfg = config.createPr;

  return [
    "create-pr",
    tool({
      description:
        `Create a pull request. ` +
        "Auto-detects repo from git remote. Handles interactive prompts automatically. " +
        "Pass provider to override the global setting (e.g. 'github' or 'azure-devops').",
      args: {
        title: tool.schema.optional(tool.schema.string()),
        body: tool.schema.optional(tool.schema.string()),
        draft: tool.schema.optional(tool.schema.boolean()),
        targetBranch: tool.schema.optional(tool.schema.string()),
        baseBranch: tool.schema.optional(tool.schema.string()),
        provider: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        try {
          const provider = getProvider(args.provider || config.provider);
          const result: CreatePrResult = await provider.createPr(
            {
              title: args.title,
              body: args.body,
              draft: args.draft,
              targetBranch: args.targetBranch || args.baseBranch,
            },
            cfg,
            root,
            $,
          );

          const lines = [`PR created: ${result.url}`];
          if (result.title) lines.push(`Title: ${result.title}`);
          if (args.draft) lines.push("(draft)");
          if (result.id) lines.push(`ID: ${result.id}`);
          return lines.join("\n");
        } catch (e: any) {
          return `PR creation failed: ${e.message || e}`;
        }
      },
    }),
  ] as const;
}
