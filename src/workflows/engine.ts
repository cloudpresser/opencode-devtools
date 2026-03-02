/**
 * Workflow Engine — Compiles a WorkflowRegistry into OpenCode Hooks.
 *
 * This is the bridge between workflow definitions and the plugin API.
 * It handles command dispatch, worker context injection, session tracking,
 * injectAfterWrite, and lifecycle hook delegation.
 */

import { join } from "node:path";
import type { WorkflowRegistry } from "./registry";
import type {
  WorkflowDefinition,
  WorkflowUtils,
  WorkflowLogger,
  AfterWriteContext,
} from "./types";
import { DEFAULT_PARAMS, parseParams } from "./types";

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

      const workflow = registry.resolveCommand(commandName);
      if (!workflow) return; // not our command, pass through

      await handleWorkflowCommand(
        workflow,
        utils,
        log,
        rawArgs,
        sessionID,
        output,
      );
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
 * Unified command handler for all workflows.
 *
 * Worktree workflows (implement, fix-defect) arrive here when spawned by the
 * CLI via `opencode run --command <workflow> '<args>'`. Direct workflows
 * (plan, merge-rebase) arrive via interactive slash commands.
 *
 * Both paths: load template → inject context → set output parts.
 * Worktree workflows additionally inject worker metadata for session analysis.
 */
async function handleWorkflowCommand(
  workflow: WorkflowDefinition,
  utils: WorkflowUtils,
  log: WorkflowLogger,
  rawArgs: string,
  sessionID: string,
  output: any,
): Promise<void> {
  // ── Parse params from raw args ──
  // Note: No validation here — the CLI validates required params before launch.
  // Worker sessions may only receive a subset of params (e.g., workerArgs
  // doesn't include baseBranch, which was consumed during worktree creation).
  const paramDefs = workflow.params ?? DEFAULT_PARAMS;
  const params = parseParams(rawArgs, paramDefs);

  // ── Load template ──
  const templatePath = resolveTemplatePath(workflow, workflow.workerTemplate);
  let template: string;
  try {
    template = utils.loadTemplate(templatePath);
  } catch (e: any) {
    log.error(
      "engine:command",
      `failed to load template for ${workflow.name}: ${e.message}`,
    );
    return;
  }

  // Append conclusion strategy fragment to template
  if (workflow.conclusion.templateFragment) {
    template += "\n" + workflow.conclusion.templateFragment;
  }

  // ── Inject context ──
  try {
    const result = await workflow.injectWorkerContext({
      params,
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

    // Worktree workflows: inject metadata for session analysis
    if (workflow.usesWorktree !== false) {
      const workerMetadata = {
        type: "workflow-worker",
        workflowName: workflow.name,
        sessionId: sessionID,
        params,
        startedAt: new Date().toISOString(),
      };
      output.parts.push({
        type: "text",
        text: `<!-- worker-metadata: ${JSON.stringify(workerMetadata)} -->`,
      });
    }
  } catch (e: any) {
    log.error(
      "engine:command",
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
