#!/usr/bin/env bun

import {
  intro,
  outro,
  multiselect,
  select,
  confirm,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

import stripJsonComments from "strip-json-comments";
import { DEFAULT_TOOLS_ENABLED, TOOL_METADATA, type ToolKey, loadConfig } from "./config";
import { generateConfig } from "./config-generator";
// Side-effect import — registers all provider adapters
import "./providers";
import { getProvider, getProviderNames } from "./providers";
import { createWorktreeDirect, spawnInTmux } from "./tools/create-worktree";
import {
  DEFAULT_PARAMS,
  parseParams,
  validateParams,
  formatParamUsage,
} from "./workflows/types";
import type { WorkflowDefinition, WorkflowUtils } from "./workflows/types";
import { WorkflowRegistry } from "./workflows/registry";

// ── Workflow registrations (same as plugin index.ts) ──
import { implementWorkflow } from "./workflows/implement";
import { defectWorkflow } from "./workflows/fix-defect";
import { planWorkflow } from "./workflows/plan";
import { mergeRebaseWorkflow } from "./workflows/merge-rebase";
import { createWorkflowDef } from "./workflows/create-workflow";
import { iterateWorkflowDef } from "./workflows/iterate-workflow";
import { debugWorkflowDef } from "./workflows/debug-workflow";

const CONFIG_FILE = ".devtools.jsonc";
const TOOL_KEYS = Object.keys(DEFAULT_TOOLS_ENABLED) as ToolKey[];

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new WorkflowRegistry();
registry.register(implementWorkflow);
registry.register(defectWorkflow);
registry.register(planWorkflow);
registry.register(mergeRebaseWorkflow);
registry.register(createWorkflowDef);
registry.register(iterateWorkflowDef);
registry.register(debugWorkflowDef);

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Build a lightweight WorkflowUtils subset for CLI resolve() calls.
 * Only provides what resolve functions actually need — fetchWorkItem and $.
 * All other methods throw if called.
 */
function createCliUtils(
  config: ReturnType<typeof loadConfig>,
  root: string,
): WorkflowUtils {
  const notAvailable = (method: string) => () => {
    throw new Error(`${method} is not available in CLI context`);
  };

  return {
    fetchWorkItem: async (id: string) => {
      const provider = getProvider(config.provider);
      const raw = await provider.fetchWorkItem(id, config.workItem, root, $);
      return { formatted: `[#${raw.id}] ${raw.title}`, raw };
    },
    processMedia: notAvailable("processMedia") as any,
    discoverPR: notAvailable("discoverPR") as any,
    formatPR: notAvailable("formatPR") as any,
    fetchPRComments: notAvailable("fetchPRComments") as any,
    loadTemplate: notAvailable("loadTemplate") as any,
    substitutePlaceholders: notAvailable("substitutePlaceholders") as any,
    launchWorker: notAvailable("launchWorker") as any,
    generateUserMessage: notAvailable("generateUserMessage") as any,
    provider: config.provider,
    $,
    log: {
      info: () => {},
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    } as any,
    root,
    config,
    client: null as any,
  };
}

// ─── Workflow Runner (Factory) ───────────────────────────────────────────────

async function runWorkflow(workflow: WorkflowDefinition, args: string[]) {
  const root = process.cwd();
  const config = loadConfig(root);
  const paramDefs = workflow.params ?? DEFAULT_PARAMS;

  // Parse positional args into named params
  const rawArgs = args.join(" ");
  const params = parseParams(rawArgs, paramDefs);
  const missing = validateParams(params, paramDefs);

  if (missing.length > 0) {
    const usage = formatParamUsage(paramDefs);
    fail(`missing required arguments: ${missing.join(", ")}\n  usage: devtools ${workflow.name} ${usage}`);
  }

  // Run resolve if present
  let resolveResult;
  if (workflow.resolve) {
    const utils = createCliUtils(config, root);
    try {
      resolveResult = await workflow.resolve({ params, utils });
    } catch (e: any) {
      fail(`resolve failed for ${workflow.name}: ${e.message}`);
    }

    if (!resolveResult) {
      const usage = formatParamUsage(paramDefs);
      fail(
        `could not resolve workflow parameters for ${workflow.name}.\n` +
        `  usage: devtools ${workflow.name} ${usage}`,
      );
    }

    // Run side effects (e.g., move work item to In-Progress)
    if (resolveResult.sideEffects) {
      try {
        await resolveResult.sideEffects();
      } catch (e: any) {
        console.warn(`warning: side effects failed (non-fatal): ${e.message}`);
      }
    }
  }

  // Dispatch based on workflow type
  if (workflow.usesWorktree !== false && resolveResult) {
    // Worktree workflow: create worktree + spawn in tmux
    console.log(`branch:  ${resolveResult.branchName}`);
    console.log(`base:    ${resolveResult.baseBranch}`);

    const result = await createWorktreeDirect({
      branchName: resolveResult.branchName,
      baseBranch: resolveResult.baseBranch,
      prompt: resolveResult.workerArgs,
      workerCommand: `/${workflow.name}`,
      workerAgentName: workflow.agent?.name,
      workerAgentModel: workflow.agent?.model,
      reuseExisting: resolveResult.reuseExisting,
      root,
      $,
    });

    if (!result.success) {
      fail(`worktree creation failed: ${result.message}`);
    }
    console.log(result.message);
  } else {
    // Direct workflow (or worktree workflow without resolve): spawn in tmux in cwd
    const result = await spawnInTmux({
      windowName: workflow.name,
      cwd: root,
      command: `/${workflow.name}`,
      prompt: rawArgs || undefined,
      agentName: workflow.agent?.name,
      agentModel: workflow.agent?.model,
      $,
    });
    console.log(result.status);
  }
}

// ─── Init Command ────────────────────────────────────────────────────────────

const readExistingConfig = (configPath: string): Set<string> | null => {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const stripped = stripJsonComments(raw).replace(/,\s*([\]}])/g, "$1");
    const parsed = JSON.parse(stripped);
    if (!parsed.tools) return null;
    return new Set(
      Object.entries(parsed.tools)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    );
  } catch {
    return null;
  }
};

async function runInit() {
  intro("opencode-devtools setup");

  const configPath = join(process.cwd(), CONFIG_FILE);
  const existing = readExistingConfig(configPath);

  if (existing) {
    const overwrite = await confirm({
      message: `${CONFIG_FILE} already exists. Overwrite?`,
    });
    if (isCancel(overwrite) || !overwrite) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
  }

  const providerNames = getProviderNames();
  const chosenProvider = await select({
    message: "Select your source-control provider:",
    options: providerNames.map((name) => ({
      value: name,
      label: name,
    })),
    initialValue: providerNames[0],
  });

  if (isCancel(chosenProvider)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  const initialValues = TOOL_KEYS.filter((key) =>
    existing ? existing.has(key) : DEFAULT_TOOLS_ENABLED[key],
  );

  const selected = await multiselect({
    message: "Select tools to enable:",
    options: TOOL_KEYS.map((key) => ({
      value: key,
      label: TOOL_METADATA[key].label,
      hint: TOOL_METADATA[key].hint,
    })),
    initialValues,
  });

  if (isCancel(selected)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  const enabledTools = new Set(selected as string[]);
  const generatedConfig = generateConfig(enabledTools, chosenProvider as string);
  writeFileSync(configPath, generatedConfig, "utf-8");

  const enabledCount = enabledTools.size;
  const disabledCount = TOOL_KEYS.length - enabledCount;

  log.success(
    `${enabledCount} tools enabled, ${disabledCount} disabled (commented out)`,
  );

  outro(
    `Config written to ${CONFIG_FILE}. Customize settings by editing the file directly.`,
  );
}

// ─── Help Text (dynamic from registry) ───────────────────────────────────────

function buildUsage(): string {
  const lines = [
    "usage: devtools <command> [args...]",
    "",
    "commands:",
    "  init                                    Set up .devtools.jsonc config",
  ];

  for (const wf of registry.getAll()) {
    const paramDefs = wf.params ?? DEFAULT_PARAMS;
    const paramStr = formatParamUsage(paramDefs);
    const left = `  ${wf.name} ${paramStr}`;
    const padding = Math.max(2, 42 - left.length);
    lines.push(`${left}${" ".repeat(padding)}${wf.description}`);
  }

  return lines.join("\n");
}

// ─── Main Dispatch ───────────────────────────────────────────────────────────

const run = async () => {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    console.log(buildUsage());
    process.exit(0);
  }

  if (command === "init") {
    await runInit();
    return;
  }

  // Look up workflow from registry
  const workflow = registry.resolveCommand(command);
  if (!workflow) {
    console.error(`unknown command: ${command}`);
    console.log(buildUsage());
    process.exit(1);
  }

  await runWorkflow(workflow, process.argv.slice(3));
};

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
