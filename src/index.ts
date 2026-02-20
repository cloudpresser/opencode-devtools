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
    const [name, def] = createPrTool(config, directory);
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

  return { tool };
};

/** @deprecated Use DevTools instead */
export const TensorTools = DevTools;

export default DevTools;
