import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
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
import { getCommandDefinitions, createCommandHook } from "./commands";
// Side-effect import — registers all provider adapters (azure-devops, github, etc.)
import "./providers";

// ─── Plugin Entry Point ──────────────────────────────────────────────────────

export const DevTools: Plugin = async (input) => {
  const { directory, $ } = input;
  const config = loadConfig(directory);
  const manager = new SessionManager();
  const enabled = config.tools;

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

  // ─── Slash Command Hooks ────────────────────────────────────────────────────
  const commandDefs = enabled.commands ? getCommandDefinitions() : null;
  const commandHook = enabled.commands
    ? createCommandHook(config, directory, $)
    : null;

  return {
    tool,

    config: async (opencodeConfig: any) => {
      if (commandDefs) {
        opencodeConfig.command ??= {};
        Object.assign(opencodeConfig.command, commandDefs);
      }
    },

    "command.execute.before": async (input: any, output: any) => {
      if (commandHook) {
        await commandHook(input, output);
      }
    },
  };
};

/** @deprecated Use DevTools instead */
export const TensorTools = DevTools;

export default DevTools;
