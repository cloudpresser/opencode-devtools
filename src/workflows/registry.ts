/**
 * Workflow Registry — Collects and validates workflow definitions.
 *
 * The registry is the central data structure that the engine compiles
 * into OpenCode hooks. It validates uniqueness of workflow names,
 * command names, and agent names across all registered workflows.
 */

import type { ToolKey } from "../config";
import type {
  WorkflowDefinition,
  WorkflowAgent,
  ToolFactory,
  AfterWriteHandler,
} from "./types";

export class WorkflowRegistry {
  private workflows = new Map<string, WorkflowDefinition>();
  private commandToWorkflow = new Map<string, string>();

  /**
   * Register a workflow definition.
   * Validates no duplicate names, command collisions, or agent name conflicts.
   */
  register(workflow: WorkflowDefinition): void {
    if (this.workflows.has(workflow.name)) {
      throw new Error(
        `Workflow "${workflow.name}" is already registered.`,
      );
    }

    // Check command name collision (each workflow gets a slash command with its name)
    if (this.commandToWorkflow.has(workflow.name)) {
      throw new Error(
        `Command "/${workflow.name}" conflicts with workflow "${this.commandToWorkflow.get(workflow.name)}".`,
      );
    }

    // Check agent name collision
    if (workflow.agent) {
      for (const [, existing] of this.workflows) {
        if (existing.agent?.name === workflow.agent.name) {
          throw new Error(
            `Agent name "${workflow.agent.name}" in workflow "${workflow.name}" ` +
              `conflicts with workflow "${existing.name}".`,
          );
        }
      }
    }

    this.workflows.set(workflow.name, workflow);
    this.commandToWorkflow.set(workflow.name, workflow.name);
  }

  /** Get all registered workflows. */
  getAll(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  /** Get a specific workflow by name. */
  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  /** Union of all requiredTools across all registered workflows + conclusion strategies. */
  getRequiredTools(): Set<ToolKey> {
    const tools = new Set<ToolKey>();
    for (const wf of this.workflows.values()) {
      for (const t of wf.requiredTools) tools.add(t);
      if (wf.conclusion.requiredTools) {
        for (const t of wf.conclusion.requiredTools) tools.add(t);
      }
    }
    // All workflows need commands enabled
    if (this.workflows.size > 0) {
      tools.add("commands");
    }
    return tools;
  }

  /**
   * Merged command definitions for OpenCode config injection.
   * Each workflow gets its own named command + a shared "workflow-run" command.
   */
  getCommandDefinitions(): Record<
    string,
    { template: string; description: string }
  > {
    const commands: Record<string, { template: string; description: string }> =
      {};

    for (const wf of this.workflows.values()) {
      commands[wf.name] = {
        template: `${wf.description}: $ARGUMENTS`,
        description: wf.description,
      };
    }

    // Generic worker dispatch command (used by framework internally)
    if (this.workflows.size > 0) {
      commands["workflow-run"] = {
        template: "Worker context injection: $ARGUMENTS",
        description: "Internal: workflow worker context injection",
      };
    }

    return commands;
  }

  /** All agent definitions from registered workflows. */
  getAgents(): WorkflowAgent[] {
    const agents: WorkflowAgent[] = [];
    for (const wf of this.workflows.values()) {
      if (wf.agent) agents.push(wf.agent);
    }
    return agents;
  }

  /** All custom tool factories from registered workflows + conclusion strategies. */
  getCustomTools(): ToolFactory[] {
    const factories: ToolFactory[] = [];
    for (const wf of this.workflows.values()) {
      if (wf.tools) factories.push(...wf.tools);
      if (wf.conclusion.tools) factories.push(...wf.conclusion.tools);
    }
    return factories;
  }

  /** Find which workflow owns a given command name. */
  resolveCommand(
    commandName: string,
  ): WorkflowDefinition | undefined {
    const workflowName = this.commandToWorkflow.get(commandName);
    return workflowName ? this.workflows.get(workflowName) : undefined;
  }

  /** Resolve the "workflow-run" dispatch: parse "<workflowName> <args>" */
  resolveWorkerDispatch(
    args: string,
  ): { workflow: WorkflowDefinition; workerArgs: string } | undefined {
    const spaceIdx = args.indexOf(" ");
    const workflowName = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
    const workerArgs = spaceIdx > 0 ? args.slice(spaceIdx + 1).trim() : "";
    const workflow = this.workflows.get(workflowName);
    return workflow ? { workflow, workerArgs } : undefined;
  }

  /** Collect all injectAfterWrite handlers from all workflows. */
  getAllAfterWriteHandlers(): AfterWriteHandler[] {
    const handlers: AfterWriteHandler[] = [];
    for (const wf of this.workflows.values()) {
      if (wf.injectAfterWrite) handlers.push(...wf.injectAfterWrite);
    }
    return handlers;
  }

  /** Map agent name → workflow name (for session tracking). */
  getAgentToWorkflowMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const wf of this.workflows.values()) {
      if (wf.agent) map.set(wf.agent.name, wf.name);
    }
    return map;
  }

  /** Number of registered workflows. */
  get size(): number {
    return this.workflows.size;
  }
}
