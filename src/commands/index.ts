import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DevToolsConfig } from "../config";
import type { WorkItemResult } from "../providers/types";
import { getProvider } from "../providers";
import { formatWorkItemResult } from "../tools/work-item";

// ─── Template Loading ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadTemplate = (name: string): string =>
  readFileSync(join(__dirname, `${name}.md`), "utf-8");

// ─── Command Definitions ──────────────────────────────────────────────────────

const COMMANDS = {
  "superior-workflow": {
    description:
      "Plan and break down a work item into dev sub-tasks (Superior Workflow)",
    templateFile: "superior-workflow",
  },
  "superior-execute": {
    description:
      "Execute a dev task: branch, red/green test, PR (Superior Workflow)",
    templateFile: "superior-execute",
  },
} as const;

type CommandName = keyof typeof COMMANDS;

const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

// ─── Work Item ID Parsing ─────────────────────────────────────────────────────

export const parseWorkItemId = (input: string): string | null => {
  const trimmed = input.trim();
  // Direct numeric ID
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Azure DevOps URL with ?workitem=XXXXX or &workitem=XXXXX
  const match = trimmed.match(/[?&]workitem=(\d+)/i);
  if (match) return match[1];
  return null;
};

// ─── Config Hook ──────────────────────────────────────────────────────────────

/**
 * Returns command definitions to inject into OpenCode's config.
 * This makes the commands appear in TUI autocomplete.
 */
export const getCommandDefinitions = (): Record<
  string,
  { template: string; description: string }
> => {
  const defs: Record<string, { template: string; description: string }> = {};
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    defs[name] = {
      template: "", // empty — we handle via command.execute.before
      description: cmd.description,
    };
  }
  return defs;
};

// ─── Command Execution Hook ───────────────────────────────────────────────────

interface CommandInput {
  command: string;
  sessionID: string;
  arguments: string;
}

interface CommandOutput {
  parts: Array<{ type: string; text: string }>;
}

/**
 * Creates the `command.execute.before` hook handler.
 *
 * When a superior-* command is invoked:
 * 1. Parses the work item ID from the arguments
 * 2. Fetches the work item via the provider adapter
 * 3. Loads the prompt template and injects the work item context
 * 4. Replaces output.parts so the LLM receives the enriched prompt
 */
export const createCommandHook = (
  config: DevToolsConfig,
  root: string,
  $: any,
) => {
  return async (input: CommandInput, output: CommandOutput) => {
    const commandName = input.command as CommandName;
    if (!COMMAND_NAMES.includes(commandName)) return;

    const cmd = COMMANDS[commandName];
    let template = loadTemplate(cmd.templateFile);

    // Parse work item ID from arguments
    const rawArgs = (input.arguments || "").trim();
    const workItemId = parseWorkItemId(rawArgs);

    let workItemContext = "";
    let workItemResult: WorkItemResult | null = null;
    if (workItemId) {
      try {
        const provider = getProvider(config.provider);
        workItemResult = await provider.fetchWorkItem(
          workItemId,
          config.workItem,
          root,
          $,
        );
        workItemContext = formatWorkItemResult(workItemResult, config.workItem);
      } catch (e: any) {
        // Fallback: let the agent fetch manually via the work-item tool
        workItemContext = [
          `> Failed to auto-fetch work item ${workItemId}: ${e.message}`,
          ">",
          "> Use the `work-item` tool to fetch it manually.",
        ].join("\n");
      }
    } else {
      workItemContext = [
        "> No work item ID provided.",
        ">",
        `> Re-run with: \`/${commandName} <id-or-url>\``,
        "> Or use the `work-item` tool to fetch context manually.",
      ].join("\n");
    }

    // Inject context into template
    template = template.replace("{{WORK_ITEM_CONTEXT}}", workItemContext);

    // For superior-execute: inject session directory and remaining work hours
    if (commandName === "superior-execute") {
      template = template.replaceAll("{{SESSION_DIRECTORY}}", root);

      const remainingWork =
        workItemResult?.fields?.["Microsoft.VSTS.Scheduling.RemainingWork"];
      template = template.replaceAll(
        "{{REMAINING_WORK}}",
        remainingWork != null ? String(remainingWork) : "unknown",
      );
    }

    // Replace output parts with our enriched prompt
    output.parts.length = 0;
    output.parts.push({ type: "text", text: template });
  };
};
