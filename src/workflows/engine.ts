/**
 * Workflow Engine — Compiles a WorkflowRegistry into OpenCode Hooks.
 *
 * This is the bridge between workflow definitions and the plugin API.
 * It handles command dispatch, launcher lifecycle, worker context injection,
 * session tracking, injectAfterWrite, and lifecycle hook delegation.
 */

import { join } from "node:path";
import type { WorkflowRegistry } from "./registry";
import type {
  WorkflowDefinition,
  WorkflowUtils,
  WorkflowLogger,
  AfterWriteContext,
} from "./types";
import { parseWorkItemId } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EngineHooks {
  config: (opencodeConfig: any) => Promise<void>;
  "command.execute.before": (input: any, output: any) => Promise<void>;
  "chat.params": (input: any, output: any) => Promise<void>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => Promise<void>;
}

// ─── File Path Extraction ─────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

function extractFilePaths(tool: string, args: any): string[] {
  if (!args) return [];
  if (tool === "multiedit") {
    return (args.edits ?? [])
      .map((e: any) => e?.filePath)
      .filter(Boolean) as string[];
  }
  return args.filePath ? [args.filePath] : [];
}

// ─── Session Tracker ──────────────────────────────────────────────────────────

/**
 * Tracks which sessions belong to which workflows.
 * Maps session ID → workflow name based on agent detection.
 */
export class SessionTracker {
  private sessions = new Map<string, string>();

  constructor(private agentToWorkflow: Map<string, string>) {}

  track(sessionID: string, agentName: string): void {
    const workflowName = this.agentToWorkflow.get(agentName);
    if (workflowName) {
      this.sessions.set(sessionID, workflowName);
    }
  }

  untrack(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  getWorkflowName(sessionID: string): string | undefined {
    return this.sessions.get(sessionID);
  }

  isTracked(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  getTrackedSessions(): string[] {
    return [...this.sessions.keys()];
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export function buildWorkflowHooks(
  registry: WorkflowRegistry,
  utils: WorkflowUtils,
  log: WorkflowLogger,
): EngineHooks {
  const agentToWorkflow = registry.getAgentToWorkflowMap();
  const sessionTracker = new SessionTracker(agentToWorkflow);

  return {
    // ── Config: inject commands + agents ──
    async config(opencodeConfig: any) {
      const commandDefs = registry.getCommandDefinitions();
      if (Object.keys(commandDefs).length > 0) {
        opencodeConfig.command ??= {};
        Object.assign(opencodeConfig.command, commandDefs);
        log.info(
          "engine:config",
          `registered ${Object.keys(commandDefs).length} commands: ${Object.keys(commandDefs).join(", ")}`,
        );
      }

      const agents = registry.getAgents();
      if (agents.length > 0) {
        opencodeConfig.agent ??= {};
        for (const agent of agents) {
          opencodeConfig.agent[agent.name] ??= {};
          const a = opencodeConfig.agent[agent.name];
          if (agent.description) a.description ??= agent.description;
          if (agent.mode) a.mode ??= agent.mode;
          if (agent.disabledTools?.length) {
            a.tools ??= {};
            for (const t of agent.disabledTools) {
              a.tools[t] ??= false;
            }
          }
          if (agent.permissions?.length) {
            a.permissions ??= {};
            for (const p of agent.permissions) {
              a.permissions[p] ??= "allow";
            }
          }
        }
        log.info(
          "engine:config",
          `registered ${agents.length} agents: ${agents.map((a) => a.name).join(", ")}`,
        );
      }
    },

    // ── Command Dispatch ──
    async "command.execute.before"(input: any, output: any) {
      const commandName = input.command;
      const sessionID = input.sessionID;
      // Strip surrounding quotes — OpenCode may wrap command arguments
      // in double quotes when passing them via --command flag.
      const rawArgs = (input.arguments || "")
        .trim()
        .replace(/^["']|["']$/g, "");

      log.info(
        "engine:command",
        `command=${commandName} session=${sessionID} args=${rawArgs}`,
      );

      // 1. Handle generic worker dispatch: /workflow-run <workflowName> <args>
      if (commandName === "workflow-run") {
        await handleWorkerDispatch(
          registry,
          utils,
          log,
          rawArgs,
          sessionID,
          output,
        );
        return;
      }

      // 2. Handle workflow launcher/direct commands: /<workflowName> <args>
      const workflow = registry.resolveCommand(commandName);
      if (!workflow) return; // not our command, pass through

      if (workflow.usesWorktree === false) {
        // Direct workflow (no worktree) — inject context into current session
        await handleDirectWorkflow(
          workflow,
          utils,
          log,
          rawArgs,
          sessionID,
          output,
        );
      } else {
        // Worktree workflow — run launcher lifecycle
        await handleLauncher(
          workflow,
          utils,
          log,
          rawArgs,
          sessionID,
          output,
        );
      }
    },

    // ── Session Tracking ──
    async "chat.params"(chatInput: any, _chatOutput: any) {
      const agentName =
        typeof chatInput.agent === "string"
          ? chatInput.agent
          : chatInput.agent?.name;
      if (agentName && agentToWorkflow.has(agentName)) {
        sessionTracker.track(chatInput.sessionID, agentName);
        log.info(
          "engine:chat.params",
          `session=${chatInput.sessionID} tracked as ${agentName} (workflow: ${sessionTracker.getWorkflowName(chatInput.sessionID)})`,
        );
      } else {
        sessionTracker.untrack(chatInput.sessionID);
      }
    },

    // ── Tool Before: delegate to workflow hooks ──
    async "tool.execute.before"(beforeInput, beforeOutput) {
      const workflowName = sessionTracker.getWorkflowName(
        beforeInput.sessionID,
      );
      if (!workflowName) return;

      // Observability logging for all tracked sessions
      log.info(
        "engine:tool.before",
        `tool=${beforeInput.tool} session=${beforeInput.sessionID} workflow=${workflowName} args=${JSON.stringify(beforeOutput.args).slice(0, 200)}`,
      );

      // Delegate to workflow-specific hooks
      const workflow = registry.get(workflowName);
      if (workflow?.hooks?.onToolBefore) {
        for (const handler of workflow.hooks.onToolBefore) {
          await handler(beforeInput, beforeOutput, log);
        }
      }
    },

    // ── Tool After: delegate hooks + injectAfterWrite ──
    async "tool.execute.after"(toolInput, toolOutput) {
      const workflowName = sessionTracker.getWorkflowName(
        toolInput.sessionID,
      );

      // 1. Delegate to workflow-specific onToolAfter hooks
      if (workflowName) {
        const workflow = registry.get(workflowName);
        if (workflow?.hooks?.onToolAfter) {
          for (const handler of workflow.hooks.onToolAfter) {
            await handler(toolInput, toolOutput, log);
          }
        }
      }

      // 2. injectAfterWrite for file-write tools
      if (WRITE_TOOLS.has(toolInput.tool)) {
        const filePaths = extractFilePaths(toolInput.tool, toolInput.args);
        // Get handlers: workflow-specific if tracked, otherwise all handlers
        const handlers = workflowName
          ? (registry.get(workflowName)?.injectAfterWrite ?? [])
          : registry.getAllAfterWriteHandlers();

        if (handlers.length > 0) {
          const ctx: AfterWriteContext = {
            tool: toolInput.tool as AfterWriteContext["tool"],
            filePaths,
            originalOutput: toolOutput.output,
            sessionID: toolInput.sessionID,
            utils,
          };

          const injections = await Promise.all(
            handlers.map((h) =>
              h(ctx).catch((err) => {
                log.error(
                  "engine:afterWrite",
                  `handler failed: ${err?.message ?? err}`,
                );
                return undefined;
              }),
            ),
          );

          const toAppend = injections.filter(Boolean).join("\n");
          if (toAppend) {
            toolOutput.output += toAppend;
          }
        }
      }
    },
  };
}

// ─── Internal Handlers ────────────────────────────────────────────────────────

/**
 * Handle /workflow-run dispatch — generic worker context injection.
 * Parses "<workflowName> <args>" and calls the workflow's injectWorkerContext.
 */
async function handleWorkerDispatch(
  registry: WorkflowRegistry,
  utils: WorkflowUtils,
  log: WorkflowLogger,
  rawArgs: string,
  sessionID: string,
  output: any,
): Promise<void> {
  const dispatch = registry.resolveWorkerDispatch(rawArgs);
  if (!dispatch) {
    log.warn("engine:worker", `no workflow found for dispatch args: ${rawArgs}`);
    return;
  }

  const { workflow, workerArgs } = dispatch;
  log.info(
    "engine:worker",
    `dispatching to workflow=${workflow.name} args=${workerArgs}`,
  );

  const templatePath = resolveTemplatePath(workflow, workflow.workerTemplate);
  let template: string;
  try {
    template = utils.loadTemplate(templatePath);
  } catch (e: any) {
    log.error(
      "engine:worker",
      `failed to load worker template: ${e.message}`,
    );
    return;
  }

  // Append conclusion strategy fragment to template
  if (workflow.conclusion.templateFragment) {
    template += "\n" + workflow.conclusion.templateFragment;
  }

  const workItemId = parseWorkItemId(workerArgs);

  try {
    const result = await workflow.injectWorkerContext({
      args: workerArgs,
      workItemId,
      template,
      sessionID,
      utils,
    });

    const finalTemplate = utils.substitutePlaceholders(
      template,
      result.templateVars,
    );

    // Structured metadata for session bridging.
    // Allows meta-workflows to identify which workflow this worker belongs to.
    const workerMetadata = {
      type: "workflow-worker",
      workflowName: workflow.name,
      workerSessionId: sessionID,
      workerArgs,
      startedAt: new Date().toISOString(),
    };

    output.parts.length = 0;
    output.parts.push(
      { type: "text", text: result.userMessage },
      { type: "text", text: finalTemplate },
      {
        type: "text",
        text: `<!-- worker-metadata: ${JSON.stringify(workerMetadata)} -->`,
      },
    );
  } catch (e: any) {
    log.error(
      "engine:worker",
      `injectWorkerContext failed for ${workflow.name}: ${e.message}`,
    );
    // Still inject the raw template so the agent has instructions
    output.parts.length = 0;
    output.parts.push(
      { type: "text", text: `${workflow.name} (context injection failed: ${e.message})` },
      { type: "text", text: template },
    );
  }
}

/**
 * Handle direct (non-worktree) workflow — inject context into current session.
 */
async function handleDirectWorkflow(
  workflow: WorkflowDefinition,
  utils: WorkflowUtils,
  log: WorkflowLogger,
  rawArgs: string,
  sessionID: string,
  output: any,
): Promise<void> {
  const templatePath = resolveTemplatePath(workflow, workflow.workerTemplate);
  let template: string;
  try {
    template = utils.loadTemplate(templatePath);
  } catch (e: any) {
    log.error(
      "engine:direct",
      `failed to load template for ${workflow.name}: ${e.message}`,
    );
    return;
  }

  // Append conclusion strategy fragment
  if (workflow.conclusion.templateFragment) {
    template += "\n" + workflow.conclusion.templateFragment;
  }

  const firstArg = rawArgs.split(/\s+/)[0] || "";
  const workItemId = parseWorkItemId(firstArg);

  try {
    const result = await workflow.injectWorkerContext({
      args: rawArgs,
      workItemId,
      template,
      sessionID,
      utils,
    });

    const finalTemplate = utils.substitutePlaceholders(
      template,
      result.templateVars,
    );

    output.parts.length = 0;
    output.parts.push(
      { type: "text", text: result.userMessage },
      { type: "text", text: finalTemplate },
    );
  } catch (e: any) {
    log.error(
      "engine:direct",
      `injectWorkerContext failed for ${workflow.name}: ${e.message}`,
    );
  }
}

/**
 * Handle worktree launcher lifecycle:
 * 1. Call workflow.resolve() for deterministic launch
 * 2. On success: create worktree → run side effects → abort session
 * 3. On undefined: inject launcher template (agent fallback)
 * 4. On error: inject launcher template with error
 */
async function handleLauncher(
  workflow: WorkflowDefinition,
  utils: WorkflowUtils,
  log: WorkflowLogger,
  rawArgs: string,
  sessionID: string,
  output: any,
): Promise<void> {
  // Parse work item ID from first arg token (not the whole args string)
  const firstArg = rawArgs.split(/\s+/)[0] || "";
  const workItemId = parseWorkItemId(firstArg);

  // If no resolve function, always go to agent fallback
  if (!workflow.resolve) {
    await injectLauncherTemplate(workflow, utils, rawArgs, output);
    return;
  }

  let resolveResult;
  try {
    resolveResult = await workflow.resolve({
      args: rawArgs,
      workItemId,
      utils,
    });
  } catch (e: any) {
    log.error(
      "engine:launcher",
      `resolve failed for ${workflow.name}: ${e.message}`,
    );
    await injectLauncherTemplate(workflow, utils, rawArgs, output, e.message);
    return;
  }

  // Agent fallback — resolve returned undefined
  if (!resolveResult) {
    await injectLauncherTemplate(workflow, utils, rawArgs, output);
    return;
  }

  // Deterministic launch
  log.info(
    "engine:launcher",
    `deterministic launch: workflow=${workflow.name} branch=${resolveResult.branchName} base=${resolveResult.baseBranch}`,
  );

  const launchResult = await utils.launchWorker({
    branchName: resolveResult.branchName,
    baseBranch: resolveResult.baseBranch,
    workerArgs: resolveResult.workerArgs,
    workflowName: workflow.name,
    agentName: workflow.agent?.name,
    agentModel: workflow.agent?.model,
    reuseExisting: resolveResult.reuseExisting,
  });

  if (launchResult.success) {
    // Run side effects (e.g., update work item state)
    if (resolveResult.sideEffects) {
      try {
        await resolveResult.sideEffects();
      } catch (e: any) {
        log.warn(
          "engine:launcher",
          `side effects failed (non-fatal): ${e.message}`,
        );
      }
    }

    // Structured metadata for launcher→worker session bridging.
    // Parseable by meta-workflows to chain launcher sessions to worker sessions.
    const launchMetadata = {
      type: "workflow-launch",
      workflowName: workflow.name,
      branchName: resolveResult.branchName,
      baseBranch: resolveResult.baseBranch,
      workerArgs: resolveResult.workerArgs,
      worktreeDir: launchResult.worktreeDir,
      workItemId: workItemId || null,
      agentName: workflow.agent?.name || null,
      launchedAt: new Date().toISOString(),
    };

    output.parts.length = 0;
    output.parts.push(
      {
        type: "text",
        text: `Worker launched for ${workflow.name}. ${launchResult.message}`,
      },
      {
        type: "text",
        text:
          "The worker session has been spawned. This session's job is done.\n" +
          "**Do NOT continue working.** The worker will handle implementation.",
      },
      {
        type: "text",
        text: `<!-- workflow-metadata: ${JSON.stringify(launchMetadata)} -->`,
      },
    );

    // Abort the launcher session
    await utils.abortSession(sessionID);
  } else {
    log.error(
      "engine:launcher",
      `worktree creation failed: ${launchResult.message}`,
    );
    // Fall back to launcher template with error
    await injectLauncherTemplate(
      workflow,
      utils,
      rawArgs,
      output,
      launchResult.message,
    );
  }
}

/**
 * Inject the launcher (fallback) template into output.
 * Used when resolve() returns undefined or throws.
 */
async function injectLauncherTemplate(
  workflow: WorkflowDefinition,
  utils: WorkflowUtils,
  rawArgs: string,
  output: any,
  error?: string,
): Promise<void> {
  const templateName = workflow.launcherTemplate || workflow.workerTemplate;
  const templatePath = resolveTemplatePath(workflow, templateName);

  let template: string;
  try {
    template = utils.loadTemplate(templatePath);
  } catch {
    // No template at all — just set a minimal message
    output.parts.length = 0;
    output.parts.push({
      type: "text",
      text: `Run the ${workflow.name} workflow with: ${rawArgs}`,
    });
    return;
  }

  const vars: Record<string, string> = {};
  if (error) vars.ERROR = error;

  const workItemId = parseWorkItemId(rawArgs);
  if (workItemId) vars.WORK_ITEM_ID = workItemId;

  const finalTemplate = utils.substitutePlaceholders(template, vars);

  output.parts.length = 0;
  output.parts.push(
    { type: "text", text: `${workflow.description}: ${rawArgs}` },
    { type: "text", text: finalTemplate },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTemplatePath(
  workflow: WorkflowDefinition,
  templateFile: string,
): string {
  if (!workflow.__dirname) {
    throw new Error(
      `Workflow "${workflow.name}" has no __dirname set. ` +
        `Set it via workflow.__dirname = import.meta.dir.`,
    );
  }
  return join(workflow.__dirname, templateFile);
}

// Re-export for diagnostics
export { SessionTracker as WorkflowSessionTracker };
