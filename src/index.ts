import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { loadConfig, type ToolKey } from "./config";
import { SessionManager } from "./session-manager";
import { createDevServerTool } from "./tools/dev-server";
import { createServerLogsTool } from "./tools/server-logs";
import { createCheckTypesTool } from "./tools/check-types";
import { createLintTool } from "./tools/lint";
import { createGenerateTool } from "./tools/generate";
import { createPrTool } from "./tools/create-pr";
import { createRunTestsTool } from "./tools/run-tests";
import { createBuildStatusTool } from "./tools/build-status";
import { createWorkItemTool } from "./tools/work-item";
import { createGetPrTool } from "./tools/get-pr";
import { createPrCommentsTool } from "./tools/pr-comments";
import {
  createPushQueueScheduleTool,
  createPushQueueLogsTool,
  createPushQueueJobsTool,
} from "./tools/push-queue";
import { createWorktreeTool } from "./tools/create-worktree";
import { createRemoveWorktreeTool } from "./tools/remove-worktree";
import { createDiagnosticsTool } from "./tools/diagnostics";
import { createSessionAnalysisTool } from "./tools/session-analysis";
import { createWorkItemCommentTool } from "./tools/work-item-comment";
import { createRegisterBranchTool } from "./tools/register-branch";
import { createLogger } from "./logger";

// Workflow framework
import { WorkflowRegistry } from "./workflows/registry";
import { buildWorkflowHooks } from "./workflows/engine";
import { createWorkflowUtils } from "./workflows/utils";

// Workflow definitions
import { implementWorkflow } from "./workflows/implement";
import { defectWorkflow } from "./workflows/fix-defect";
import { planWorkflow } from "./workflows/plan";
import { mergeRebaseWorkflow } from "./workflows/merge-rebase";
import { createWorkflowDef } from "./workflows/create-workflow";
import { iterateWorkflowDef } from "./workflows/iterate-workflow";
import { debugWorkflowDef } from "./workflows/debug-workflow";

// Side-effect import — registers all provider adapters (azure-devops, github, etc.)
import "./providers";

// ─── Plugin Entry Point ──────────────────────────────────────────────────────

export const DevTools: Plugin = async (input) => {
  const { directory, $, client } = input;
  const config = loadConfig(directory);
  const manager = new SessionManager();
  const log = createLogger();

  // ── 1. Register all workflows unconditionally ──
  // Slash commands are always available. Workflows override tool configs:
  // their requiredTools are force-enabled regardless of project config.
  const registry = new WorkflowRegistry();
  registry.register(implementWorkflow);
  registry.register(defectWorkflow);
  registry.register(planWorkflow);
  registry.register(mergeRebaseWorkflow);
  registry.register(createWorkflowDef);
  registry.register(iterateWorkflowDef);
  registry.register(debugWorkflowDef);

  log.info(
    "init",
    `directory=${directory} provider=${config.provider} workflows=${registry.getAll().map((w) => w.name).join(",")}`,
  );

  // ── 2. Compute enabled tools (config flags + workflow requirements) ──
  const enabled = { ...config.tools };
  const requiredTools = registry.getRequiredTools();
  for (const key of requiredTools) {
    enabled[key] = true;
  }

  // ── 3. Register standard tools ──
  const tool: NonNullable<Hooks["tool"]> = {};

  if (enabled["dev-server"]) {
    const [name, def] = createDevServerTool(config, manager, directory);
    tool[name] = def;
  }
  if (enabled["server-logs"]) {
    const [name, def] = createServerLogsTool(config, manager);
    tool[name] = def;
  }
  if (enabled["check-types"]) {
    const [name, def] = createCheckTypesTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled.lint) {
    const [name, def] = createLintTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled.generate) {
    const [name, def] = createGenerateTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled["create-pr"]) {
    const [name, def] = createPrTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled["run-tests"]) {
    const [name, def] = createRunTestsTool(config, manager, directory, $);
    tool[name] = def;
  }
  if (enabled["build-status"]) {
    const [name, def] = createBuildStatusTool(config, manager, directory, $);
    tool[name] = def;
  }
  if (enabled["work-item"]) {
    const [name, def] = createWorkItemTool(config, directory, $);
    tool[name] = def;
    const [wcn, wcd] = createWorkItemCommentTool(config, directory, $, log);
    tool[wcn] = wcd;
  }
  if (enabled["get-pr"]) {
    const [name, def] = createGetPrTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled["pr-comments"]) {
    const [name, def] = createPrCommentsTool(config, directory, $);
    tool[name] = def;
  }
  if (enabled["push-queue"]) {
    const [n1, d1] = createPushQueueScheduleTool(config, directory, $);
    const [n2, d2] = createPushQueueLogsTool(config, directory, $);
    const [n3, d3] = createPushQueueJobsTool(config, directory, $);
    tool[n1] = d1;
    tool[n2] = d2;
    tool[n3] = d3;
  }
  if (enabled.commands) {
    const [wn, wd] = createWorktreeTool(config, directory, $);
    tool[wn] = wd;
    const [rn, rd] = createRemoveWorktreeTool(config, directory, $);
    tool[rn] = rd;
  }

  // ── 4. Register workflow-contributed tools (e.g., commit from push-queue conclusion) ──
  for (const factory of registry.getCustomTools()) {
    const [name, def] = factory(config, directory, $);
    tool[name] = def;
  }

  // ── 5. Always-on tools ──
  {
    const [dn, dd] = createDiagnosticsTool(log, () => ({
      workerSessions: [] as string[], // TODO: expose from engine session tracker
      registeredTools: Object.keys(tool),
      config: {
        provider: config.provider,
        tools: enabled,
      },
    }));
    tool[dn] = dd;
  }
  {
    const [sn, sd] = createSessionAnalysisTool($);
    tool[sn] = sd;
  }
  {
    const [rbn, rbd] = createRegisterBranchTool();
    tool[rbn] = rbd;
  }

  log.info(
    "init",
    `registered ${Object.keys(tool).length} tools: ${Object.keys(tool).join(", ")}`,
  );

  // ── 6. Build workflow hooks from registry ──
  const utils = createWorkflowUtils(config, directory, $, client, log);
  const workflowHooks = buildWorkflowHooks(registry, utils, log);

  return {
    tool,

    config: async (opencodeConfig: any) => {
      await workflowHooks.config(opencodeConfig);
    },

    "command.execute.before": async (cmdInput: any, cmdOutput: any) => {
      await workflowHooks["command.execute.before"](cmdInput, cmdOutput);
    },

    "chat.params": async (chatInput: any, chatOutput: any) => {
      await workflowHooks["chat.params"](chatInput, chatOutput);
    },

    "tool.execute.before": async (
      beforeInput: { tool: string; sessionID: string; callID: string },
      beforeOutput: { args: any },
    ) => {
      await workflowHooks["tool.execute.before"](beforeInput, beforeOutput);
    },

    "tool.execute.after": async (
      toolInput: {
        tool: string;
        sessionID: string;
        callID: string;
        args: any;
      },
      toolOutput: { title: string; output: string; metadata: any },
    ) => {
      await workflowHooks["tool.execute.after"](toolInput, toolOutput);
    },
  };
};

/** @deprecated Use DevTools instead */
export const TensorTools = DevTools;

export default DevTools;
