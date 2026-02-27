/**
 * Debug Workflow — Diagnose issues with workflow dispatch, session
 * resolution, and the overall plugin lifecycle.
 *
 * Command: /debug-workflow <sessionId | workflowName | "dispatch" | "hooks">
 *
 * Runs in current session (no worktree). The agent is given:
 * - Plugin diagnostics state (registered workflows, tools, sessions)
 * - Recent plugin logs
 * - Session analysis (if session ID provided)
 * - Dispatch chain analysis (command → engine → registry → handler)
 * - Session resolution chain analysis (launcher → worker bridging)
 * - File paths to all key framework files for investigation
 *
 * The template instructs the agent to methodically diagnose the
 * issue, check each link in the chain, and propose a fix.
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
  exportAndParse,
  analyzeForIteration,
} from "../session-parsing";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPluginDir(): string {
  return join(import.meta.dir, "..");
}

function getPluginSrcDir(): string {
  return join(import.meta.dir, "../..");
}

function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return `> Could not read ${path}`;
  }
}

async function getRecentLogs($: any, lines = 100): Promise<string> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logDir = join(
      process.env.HOME || "~",
      ".local/share/opencode-devtools/logs",
    );
    const logFile = join(logDir, `plugin-${today}.log`);
    if (!existsSync(logFile)) return "> No log file found for today.";
    const content = readFileSync(logFile, "utf-8");
    const logLines = content.split("\n");
    return logLines.slice(-lines).join("\n");
  } catch (e: any) {
    return `> Could not read logs: ${e.message}`;
  }
}

async function getDiagnostics($: any): Promise<string> {
  try {
    // The devtools-diagnostics tool returns plugin state
    // We'll read recent logs and parse them for state info
    const logs = await getRecentLogs($, 200);

    // Extract key patterns from logs
    const sections: string[] = [];

    // Find init messages
    const initLines = logs
      .split("\n")
      .filter((l) => l.includes("[init]"));
    if (initLines.length > 0) {
      sections.push("### Plugin Initialization");
      sections.push(
        initLines
          .slice(-3)
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    }

    // Find dispatch warnings/errors
    const dispatchLines = logs
      .split("\n")
      .filter(
        (l) =>
          l.includes("engine:") ||
          l.includes("dispatch") ||
          l.includes("workflow"),
      );
    if (dispatchLines.length > 0) {
      sections.push("### Engine/Dispatch Events (last 20)");
      sections.push(
        dispatchLines
          .slice(-20)
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    }

    // Find errors
    const errorLines = logs
      .split("\n")
      .filter((l) => l.includes("[ERROR]") || l.includes("[WARN]"));
    if (errorLines.length > 0) {
      sections.push("### Errors and Warnings (last 20)");
      sections.push(
        errorLines
          .slice(-20)
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    }

    return sections.join("\n\n") || "> No relevant log entries found.";
  } catch (e: any) {
    return `> Could not gather diagnostics: ${e.message}`;
  }
}

function listRegisteredWorkflows(): string {
  const workflowsDir = getPluginDir();
  try {
    const dirs = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => existsSync(join(workflowsDir, d.name, "index.ts")))
      .map((d) => {
        const indexContent = safeReadFile(
          join(workflowsDir, d.name, "index.ts"),
        );
        const nameMatch = indexContent.match(/name:\s*["']([^"']+)["']/);
        const descMatch = indexContent.match(
          /description:\s*["']([^"']+)["']/,
        );
        const worktreeMatch = indexContent.match(
          /usesWorktree:\s*(true|false)/,
        );
        return `  - **${d.name}/** → name: \`${nameMatch?.[1] || "?"}\`, desc: "${descMatch?.[1] || "?"}", worktree: ${worktreeMatch?.[1] || "true (default)"}`;
      });
    return dirs.join("\n") || "> No workflow directories found.";
  } catch {
    return "> Could not list workflow directories.";
  }
}

// ─── Context Injection ────────────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  const args = ctx.args.trim();
  const parts = args.split(/\s+/);

  let sessionAnalysis = "";
  let sessionId = "";
  let targetArea = "general";

  // Parse args — could be a session ID, workflow name, or diagnostic area
  for (const part of parts) {
    if (part.startsWith("ses_")) {
      sessionId = part;
      targetArea = "session";
    } else if (
      ["dispatch", "hooks", "resolution", "all"].includes(
        part.toLowerCase(),
      )
    ) {
      targetArea = part.toLowerCase();
    }
  }

  // Session analysis if ID provided
  if (sessionId) {
    const data = await exportAndParse(sessionId, ctx.utils.$);
    if (data) {
      sessionAnalysis = analyzeForIteration(data);

      // Check for metadata blocks
      let hasLauncherMeta = false;
      let hasWorkerMeta = false;
      for (const msg of data.messages || []) {
        for (const p of msg.parts || []) {
          if (p.type === "text" && p.text) {
            if (p.text.includes("workflow-metadata:"))
              hasLauncherMeta = true;
            if (p.text.includes("worker-metadata:"))
              hasWorkerMeta = true;
          }
        }
      }

      sessionAnalysis += "\n\n### Metadata Blocks\n";
      sessionAnalysis += `- Launcher metadata (\`<!-- workflow-metadata: -->\`): ${hasLauncherMeta ? "**PRESENT**" : "**MISSING** — engine's handleLauncher didn't inject it"}\n`;
      sessionAnalysis += `- Worker metadata (\`<!-- worker-metadata: -->\`): ${hasWorkerMeta ? "**PRESENT**" : "**MISSING** — engine's handleWorkerDispatch didn't inject it"}\n`;

      if (!hasWorkerMeta && !hasLauncherMeta) {
        sessionAnalysis +=
          "\n> **Neither metadata block present.** This session may have been created before metadata injection was implemented, or the engine's command.execute.before hook didn't fire/match.\n";
      }
    } else {
      sessionAnalysis = `> Failed to export session ${sessionId}. It may not exist or the export format may be incompatible.`;
    }
  }

  // Gather diagnostics
  const diagnostics = await getDiagnostics(ctx.utils.$);
  const registeredWorkflows = listRegisteredWorkflows();
  const recentLogs = await getRecentLogs(ctx.utils.$, 50);

  // Key framework file locations for the agent to read
  const pluginSrc = getPluginSrcDir();
  const frameworkFiles = [
    `${pluginSrc}/index.ts`,
    `${pluginSrc}/workflows/engine.ts`,
    `${pluginSrc}/workflows/registry.ts`,
    `${pluginSrc}/workflows/session-resolution.ts`,
    `${pluginSrc}/workflows/utils.ts`,
    `${pluginSrc}/tools/create-worktree.ts`,
    `${pluginSrc}/tools/session-analysis.ts`,
  ]
    .map((f) => `  - \`${f}\``)
    .join("\n");

  return {
    userMessage: sessionId
      ? `Debug workflow issue for session ${sessionId}`
      : `Debug workflow infrastructure (${targetArea})`,
    templateVars: {
      TARGET_AREA: targetArea,
      SESSION_ID: sessionId || "(none provided)",
      SESSION_ANALYSIS:
        sessionAnalysis || "> No session ID provided for analysis.",
      DIAGNOSTICS: diagnostics,
      REGISTERED_WORKFLOWS: registeredWorkflows,
      RECENT_LOGS: recentLogs,
      FRAMEWORK_FILES: frameworkFiles,
      PLUGIN_SRC_DIR: pluginSrc,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const debugWorkflowDef: WorkflowDefinition = {
  name: "debug-workflow",
  description: "Diagnose workflow dispatch, resolution, and lifecycle issues",
  requiredTools: [],
  workerTemplate: "debug-workflow.md",
  usesWorktree: false,
  injectWorkerContext,
  conclusion: noneConclusion,
  __dirname: import.meta.dir,
};
