/**
 * Iterate Workflow — Analyze session results and iterate on workflow definitions.
 *
 * Direct command: /iterate-workflow <sessionId>
 * Runs in the current session (interactive, collaborative with user).
 *
 * Exports a session, auto-detects which workflow was used, reads the
 * current workflow definition, and helps the user iterate on it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  analyzeForIteration,
} from "../session-parsing";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the plugin's workflows directory from this module's location. */
function getPluginWorkflowsDir(): string {
  return join(import.meta.dir, "..");
}

/**
 * Auto-detect which workflow was used in a session by scanning
 * its text parts and worker metadata for workflow identifiers.
 */
function detectWorkflowFromExport(
  data: import("../session-parsing").SessionExport,
): string | null {
  const knownWorkflows = [
    "implement",
    "fix-defect",
    "plan",
    "merge-rebase",
    "create-workflow",
    "iterate-workflow",
  ];

  for (const msg of data.messages || []) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && part.text) {
        // Check for worker metadata block
        const workerMatch = part.text.match(
          /<!-- worker-metadata:.*?"workflowName"\s*:\s*"([^"]+)"/,
        );
        if (workerMatch) return workerMatch[1];

        // Check for workflow-run dispatch
        const runMatch = part.text.match(/workflow-run\s+(\S+)/);
        if (runMatch && knownWorkflows.includes(runMatch[1]))
          return runMatch[1];

        // Check for slash commands
        for (const name of knownWorkflows) {
          if (part.text.includes(`/${name} `) || part.text.includes(`/${name}\n`)) {
            return name;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Find the worker template file in a workflow directory.
 * Workflows use different names (worker.md, plan.md, etc.).
 */
function findWorkerTemplate(workflowDir: string): string | null {
  try {
    const files = readdirSync(workflowDir);
    const mdFile = files.find(
      (f) => f.endsWith(".md") && !f.includes("launcher"),
    );
    return mdFile ? join(workflowDir, mdFile) : null;
  } catch {
    return null;
  }
}

/**
 * Run session analysis via `opencode export` and produce a detailed
 * summary focused on iteration insights.
 */
async function runSessionAnalysis(
  sessionId: string,
  $: any,
): Promise<string> {
  const data = await exportAndParse(sessionId, $);
  if (!data) {
    return `> Failed to export session ${sessionId}. Use the \`session-analysis\` tool to analyze manually.`;
  }
  return analyzeForIteration(data);
}

/** Read a file safely, returning a fallback message on failure. */
function safeReadFile(path: string, label: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8");
    return `> ${label} not found at ${path}`;
  } catch {
    return `> Could not read ${label}`;
  }
}

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  const rawSessionId = ctx.args.trim();

  if (!rawSessionId || !rawSessionId.startsWith("ses_")) {
    return {
      userMessage: "Iterate on a workflow — provide a session ID",
      templateVars: {
        SESSION_ID: rawSessionId || "(none)",
        SESSION_ANALYSIS:
          "> No valid session ID provided. Please provide a session ID starting with `ses_`.",
        WORKFLOW_NAME: "unknown",
        WORKFLOW_DEFINITION: "> Could not detect workflow.",
        WORKFLOW_TEMPLATE: "",
        PLUGIN_WORKFLOWS_DIR: getPluginWorkflowsDir(),
      },
    };
  }

  // 1. Resolve launcher→worker session chain
  let resolved;
  try {
    resolved = await resolveWorkerSession(
      rawSessionId,
      ctx.utils.$,
      ctx.utils.client,
    );
  } catch (e) {
    if (e instanceof WorkerSessionNotFoundError) {
      return {
        userMessage: `Could not find worker session for launcher ${rawSessionId}`,
        templateVars: {
          SESSION_ID: rawSessionId,
          SESSION_ANALYSIS:
            `> **Error:** ${e.message}\n\n` +
            `> Provide the worker session ID directly instead of the launcher session ID.`,
          WORKFLOW_NAME: e.launcherMetadata.workflowName || "unknown",
          WORKFLOW_DEFINITION: "> Worker session not found — cannot read workflow definition.",
          WORKFLOW_TEMPLATE: "",
          PLUGIN_WORKFLOWS_DIR: getPluginWorkflowsDir(),
        },
      };
    }
    throw e;
  }

  const targetSessionId = resolved.targetSessionId;

  // 2. Analyze the resolved target session
  let sessionAnalysis = await runSessionAnalysis(
    targetSessionId,
    ctx.utils.$,
  );

  // Prepend resolution note if launcher was detected
  if (resolved.isLauncher) {
    const meta = resolved.launcherMetadata!;
    let note = `> **Launcher session detected** (\`${rawSessionId}\`).\n`;
    note += `> Chained to worker session: \`${resolved.workerSessionId}\`\n`;
    note += `> Workflow: ${meta.workflowName}, Branch: ${meta.branchName}\n\n`;
    sessionAnalysis = note + sessionAnalysis;
  }

  // 3. Detect workflow name — launcher metadata takes priority
  let workflowName: string | null = null;
  if (resolved.isLauncher && resolved.launcherMetadata) {
    workflowName = resolved.launcherMetadata.workflowName;
  } else {
    // Auto-detect from target session export
    const exportData = await exportAndParse(targetSessionId, ctx.utils.$);
    if (exportData) {
      workflowName = detectWorkflowFromExport(exportData);
    }
  }

  // 4. Read current workflow definition if detected
  const workflowsDir = getPluginWorkflowsDir();
  let workflowDef =
    "> Could not auto-detect which workflow was used in this session.";
  let workflowTemplate = "";

  if (workflowName) {
    const workflowDir = join(workflowsDir, workflowName);
    workflowDef = safeReadFile(
      join(workflowDir, "index.ts"),
      "Workflow definition",
    );

    const templatePath = findWorkerTemplate(workflowDir);
    if (templatePath) {
      workflowTemplate = safeReadFile(templatePath, "Worker template");
    }
  }

  return {
    userMessage: workflowName
      ? `Iterate on the "${workflowName}" workflow based on session ${resolved.workerSessionId || targetSessionId}`
      : `Analyze session ${targetSessionId} and iterate on the workflow`,
    templateVars: {
      SESSION_ID: targetSessionId,
      SESSION_ANALYSIS: sessionAnalysis,
      WORKFLOW_NAME: workflowName || "unknown",
      WORKFLOW_DEFINITION: workflowDef,
      WORKFLOW_TEMPLATE: workflowTemplate,
      PLUGIN_WORKFLOWS_DIR: workflowsDir,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const iterateWorkflowDef: WorkflowDefinition = {
  name: "iterate-workflow",
  description: "Analyze workflow session results and iterate on the definition",
  requiredTools: [],
  workerTemplate: "iterate-workflow.md",
  usesWorktree: false,
  injectWorkerContext,
  conclusion: noneConclusion,
  __dirname: import.meta.dir,
};
