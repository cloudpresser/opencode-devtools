/**
 * Create Workflow — Meta-workflow for creating new instrumented workflows.
 *
 * Direct command: /create-workflow [sessionId] [path/to/command.md]
 * Runs in the current session (interactive, asks questions).
 *
 * Ingests a session transcript and/or a slash command file, analyzes
 * the patterns, proposes a complete workflow design, and implements it
 * after user confirmation.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type {
  WorkflowDefinition,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import { noneConclusion } from "../conclusions";
import {
  resolveWorkerSession,
  WorkerSessionNotFoundError,
} from "../session-resolution";
import {
  exportAndParse,
  analyzeForWorkflowCreation,
} from "../session-parsing";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the plugin's workflows directory from this module's location. */
function getPluginWorkflowsDir(): string {
  return join(import.meta.dir, "..");
}

/** Resolve the plugin's src directory. */
function getPluginSrcDir(): string {
  return join(import.meta.dir, "../..");
}

/**
 * Run session analysis via `opencode export` and produce a summary.
 */
async function runSessionAnalysis(
  sessionId: string,
  $: any,
): Promise<string> {
  const data = await exportAndParse(sessionId, $);
  if (!data) {
    return `> Failed to export session ${sessionId}. The agent should use the \`session-analysis\` tool to analyze this session instead.`;
  }
  return analyzeForWorkflowCreation(data);
}

/** Read a reference file from the plugin source, return its contents. */
function readPluginFile(relativePath: string): string {
  const fullPath = join(getPluginSrcDir(), relativePath);
  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return `> Could not read ${relativePath}`;
  }
}

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  const args = ctx.args.trim();
  const parts = args.split(/\s+/);

  let sessionAnalysis = "";
  let commandFile = "";
  let userMessage = "Create a new workflow";

  for (const part of parts) {
    if (part.startsWith("ses_")) {
      // Session ID — resolve launcher→worker chain if needed
      try {
        const resolved = await resolveWorkerSession(
          part,
          ctx.utils.$,
          ctx.utils.client,
        );
        const targetId = resolved.targetSessionId;

        sessionAnalysis = await runSessionAnalysis(targetId, ctx.utils.$);

        // Prepend resolution note so the agent knows what happened
        if (resolved.isLauncher) {
          const meta = resolved.launcherMetadata!;
          let note = `> **Launcher session detected** (${part}).\n`;
          note += `> Chained to worker session: \`${resolved.workerSessionId}\`\n`;
          note += `> Workflow: ${meta.workflowName}, Branch: ${meta.branchName}\n\n`;
          sessionAnalysis = note + sessionAnalysis;
        }

        userMessage =
          resolved.isLauncher && resolved.workerSessionId
            ? `Create a new workflow from session ${resolved.workerSessionId} (via launcher ${part})`
            : `Create a new workflow from session ${targetId}`;
      } catch (e) {
        if (e instanceof WorkerSessionNotFoundError) {
          sessionAnalysis =
            `> **Error:** ${e.message}\n\n` +
            `> Provide the worker session ID directly instead of the launcher session ID.`;
          userMessage = `Could not find worker session for launcher ${part}`;
        } else {
          throw e;
        }
      }
    } else if (part.endsWith(".md") || part.includes("/")) {
      // File path — read the command/template file
      const resolved = isAbsolute(part)
        ? part
        : resolve(ctx.utils.root, part);
      if (existsSync(resolved)) {
        commandFile = readFileSync(resolved, "utf-8");
        userMessage = commandFile
          ? `Create a new workflow from ${part}`
          : userMessage;
      } else {
        commandFile = `> File not found: ${resolved}`;
      }
    }
  }

  // Read reference files from the plugin source
  const exampleWorkflow = readPluginFile(
    "workflows/merge-rebase/index.ts",
  );
  const exampleTemplate = readPluginFile(
    "workflows/merge-rebase/worker.md",
  );
  const frameworkTypes = readPluginFile("workflows/types.ts");
  const conclusionStrategies = readPluginFile("workflows/conclusions.ts");
  const testingHarness = readPluginFile("workflows/testing.ts");

  const pluginWorkflowsDir = getPluginWorkflowsDir();
  const pluginIndexPath = join(getPluginSrcDir(), "index.ts");

  return {
    userMessage,
    templateVars: {
      SESSION_ANALYSIS:
        sessionAnalysis ||
        "> No session ID provided. Work from user conversation and any command file below.",
      COMMAND_FILE:
        commandFile || "> No command file provided.",
      EXAMPLE_WORKFLOW: exampleWorkflow,
      EXAMPLE_TEMPLATE: exampleTemplate,
      FRAMEWORK_TYPES: frameworkTypes,
      CONCLUSION_STRATEGIES: conclusionStrategies,
      TESTING_HARNESS: testingHarness,
      PLUGIN_WORKFLOWS_DIR: pluginWorkflowsDir,
      PLUGIN_INDEX_PATH: pluginIndexPath,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const createWorkflowDef: WorkflowDefinition = {
  name: "create-workflow",
  description: "Create a new instrumented workflow from session analysis or command file",
  requiredTools: [],
  workerTemplate: "create-workflow.md",
  usesWorktree: false,
  injectWorkerContext,
  conclusion: noneConclusion,
  __dirname: import.meta.dir,
};
