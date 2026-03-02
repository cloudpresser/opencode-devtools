/**
 * Workflow Abstraction — Core Type Definitions
 *
 * Every agentic workflow in the plugin is defined as a `WorkflowDefinition`.
 * The framework handles launcher registration, worker dispatch, worktree
 * creation, session tracking, and conclusion strategies. Workflows only
 * need to define their context resolution and injection logic.
 */

import type { DevToolsConfig, ToolKey } from "../config";
import type { WorkItemResult, PrResult, PrCommentThread } from "../providers/types";

// ─── Shared Utilities ─────────────────────────────────────────────────────────

/**
 * Shared utilities available to all workflow handlers.
 * These eliminate duplicated fetch→format→inject patterns across workflows.
 */
export interface WorkflowUtils {
  /** Fetch and format a work item. Includes "do-not-refetch" note. */
  fetchWorkItem(id: string): Promise<{
    formatted: string;
    raw: WorkItemResult;
  }>;

  /**
   * Process media (images/videos) from work item HTML fields + attachments.
   * Returns formatted markdown or empty string if no media.
   */
  processMedia(
    fields: Record<string, any>,
    attachments?: { name: string; url: string }[],
  ): Promise<string>;

  /**
   * Discover the active PR linked to a work item (checks direct links,
   * then parent work item links). Returns the active PR, preferring
   * "active" status.
   */
  discoverPR(workItem: WorkItemResult): Promise<
    | { pr: PrResult; prId: string }
    | undefined
  >;

  /** Format a PR result for template injection. */
  formatPR(prId: string): Promise<string>;

  /** Fetch active PR comments, formatted for injection. */
  fetchPRComments(prId: string): Promise<string>;

  /** Load a template file from an absolute path. */
  loadTemplate(absolutePath: string): string;

  /** Replace all {{KEY}} placeholders in a template. */
  substitutePlaceholders(
    template: string,
    vars: Record<string, string>,
  ): string;

  /** Create a worktree and spawn a tmux worker session. */
  launchWorker(opts: WorkerLaunchOpts): Promise<WorkerLaunchResult>;

  /** Generate a natural-language user message for the command. */
  generateUserMessage(
    workflowName: string,
    workItemResult: WorkItemResult | null,
    workItemId: string | null,
    rawArgs: string,
  ): string;

  /** The configured provider name */
  readonly provider: string;
  /** Shell access */
  readonly $: any;
  /** Logger */
  readonly log: WorkflowLogger;
  /** Project root directory */
  readonly root: string;
  /** Full plugin config */
  readonly config: DevToolsConfig;
  /** OpenCode client (for session management, media processing) */
  readonly client: any;
}

export interface WorkerLaunchOpts {
  branchName: string;
  baseBranch: string;
  /** Args passed to the worker command (typically work item ID) */
  workerArgs: string;
  /** Workflow name — used to build the worker command */
  workflowName: string;
  /** Agent name to use in the worker session */
  agentName?: string;
  /** Agent model to use */
  agentModel?: string;
  /** Reuse existing worktree/branch if present */
  reuseExisting?: boolean;
  /** Override worktree root directory */
  worktreeRoot?: string;
}

export interface WorkerLaunchResult {
  success: boolean;
  message: string;
  worktreeDir: string;
}

export interface WorkflowLogger {
  info(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
  error(tag: string, msg: string): void;
}

// ─── Workflow Definition ──────────────────────────────────────────────────────

export interface WorkflowDefinition {
  /** Unique workflow name. Used as config key, command name, and routing key. */
  name: string;
  /** Human-readable description (shown in TUI autocomplete). */
  description: string;

  /** Tool keys this workflow needs force-enabled. */
  requiredTools: ToolKey[];

  /**
   * Worker template file path (relative to the workflow module directory).
   * Loaded by the framework and passed to `injectWorkerContext`.
   */
  workerTemplate: string;

  /**
   * Declared positional parameters for this workflow.
   * Used by the CLI for help text generation and argument parsing,
   * and by the engine for parameter validation before dispatch.
   *
   * If not specified, defaults to a single optional `prompt` param.
   */
  params?: WorkflowParam[];

  /**
   * Whether this workflow uses the worktree pattern.
   * - `true` (default): Launched via CLI, creates a worktree and spawns
   *   an agent session in tmux. The slash command bootstraps the worker.
   * - `false`: Runs in the current session (no worktree, no separate agent).
   */
  usesWorktree?: boolean;

  /**
   * Pre-launch context resolution. Called by the CLI/engine before dispatch.
   *
   * Return `ResolveResult` for deterministic launch.
   * Return `undefined` if resolution fails (CLI exits with error).
   */
  resolve?: (ctx: ResolveContext) => Promise<ResolveResult | undefined>;

  /**
   * Inject context into the worker (or direct) session.
   * Called by the framework when the worker command dispatches to this workflow,
   * or directly for non-worktree workflows.
   *
   * Returns template variables to substitute into `workerTemplate`.
   */
  injectWorkerContext: (
    ctx: WorkerContext,
  ) => Promise<WorkerContextResult>;

  /** How this workflow concludes its work. */
  conclusion: ConclusionStrategy;

  /** Agent configuration for the worker session. */
  agent?: WorkflowAgent;

  /** Extra tools this workflow contributes (e.g., commit tool). */
  tools?: ToolFactory[];

  /** Optional lifecycle hooks. */
  hooks?: {
    onToolBefore?: ToolBeforeHandler[];
    onToolAfter?: ToolAfterHandler[];
  };

  /** Handlers that run after file write operations (write/edit/patch/multiedit). */
  injectAfterWrite?: AfterWriteHandler[];

  /**
   * The directory containing this workflow's module and templates.
   * Set automatically by the registry from `import.meta.dir`.
   */
  __dirname?: string;
}

// ─── Workflow Parameters ──────────────────────────────────────────────────────

/**
 * Declares a positional parameter for a workflow.
 * The framework uses these to parse CLI args, generate help text,
 * and validate required params before calling resolve/injectWorkerContext.
 */
export interface WorkflowParam {
  /** Parameter name (used as key in `params` record and in CLI help text). */
  name: string;
  /** Whether this parameter is required (CLI/engine validates before dispatch). */
  required: boolean;
  /** Description for CLI help text. */
  description?: string;
}

/** Default param for workflows that don't declare explicit params. */
export const DEFAULT_PARAMS: WorkflowParam[] = [
  { name: "prompt", required: false, description: "Freeform arguments" },
];

/**
 * Parse a raw args string into a named params record using workflow param declarations.
 * Positionals are mapped by index to param names.
 */
export function parseParams(
  rawArgs: string,
  paramDefs: WorkflowParam[],
): Record<string, string | undefined> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const params: Record<string, string | undefined> = {};
  for (let i = 0; i < paramDefs.length; i++) {
    if (i === paramDefs.length - 1 && tokens.length > i) {
      // Last param consumes all remaining tokens
      params[paramDefs[i].name] = tokens.slice(i).join(" ");
    } else {
      params[paramDefs[i].name] = tokens[i];
    }
  }
  return params;
}

/**
 * Validate that all required params are present.
 * Returns list of missing param names (empty if all present).
 */
export function validateParams(
  params: Record<string, string | undefined>,
  paramDefs: WorkflowParam[],
): string[] {
  return paramDefs
    .filter((p) => p.required && !params[p.name])
    .map((p) => p.name);
}

/**
 * Generate a CLI usage string from param declarations.
 * Required params: `<name>`, optional: `[name]`.
 */
export function formatParamUsage(paramDefs: WorkflowParam[]): string {
  return paramDefs
    .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
    .join(" ");
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

export interface ResolveContext {
  /** Parsed named parameters (from workflow's `params` declaration). */
  params: Record<string, string | undefined>;
  /** Shared utilities. */
  utils: WorkflowUtils;
}

export interface ResolveResult {
  /** Branch name for the worktree. */
  branchName: string;
  /** Base branch to create from. */
  baseBranch: string;
  /** Args to pass to the worker (typically work item ID). */
  workerArgs: string;
  /** Reuse existing worktree/branch if present. */
  reuseExisting?: boolean;
  /** Side effects to run after successful worktree creation (e.g., update work item state). */
  sideEffects?: () => Promise<void>;
}

// ─── Worker Context Injection ─────────────────────────────────────────────────

export interface WorkerContext {
  /** Parsed named parameters (from workflow's `params` declaration). */
  params: Record<string, string | undefined>;
  /** The loaded worker template content. */
  template: string;
  /** Session ID. */
  sessionID: string;
  /** Shared utilities. */
  utils: WorkflowUtils;
}

export interface WorkerContextResult {
  /** User-facing message (first output part). */
  userMessage: string;
  /** Template variables: each `{{KEY}}` in the template is replaced with the value. */
  templateVars: Record<string, string>;
}

// ─── Conclusion Strategies ────────────────────────────────────────────────────

export interface ConclusionStrategy {
  /** Strategy name for identification. */
  name: string;
  /**
   * Template fragment appended to the worker template.
   * Contains instructions for how the agent should conclude its work.
   */
  templateFragment: string;
  /** Additional tool keys this strategy needs. */
  requiredTools?: ToolKey[];
  /** Additional tool factories to register. */
  tools?: ToolFactory[];
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export interface WorkflowAgent {
  /** Agent name (must be unique across all workflows). */
  name: string;
  /** Model ID (e.g., "opencode/claude-opus-4-6"). */
  model?: string;
  /** Agent mode. */
  mode?: "all" | "tool";
  /** Description shown in agent registry. */
  description?: string;
  /** Tools to disable for this agent. */
  disabledTools?: string[];
  /** Permissions to pre-allow (e.g., external_directory, doom_loop). */
  permissions?: string[];
}

// ─── Lifecycle Hooks ──────────────────────────────────────────────────────────

export type ToolBeforeHandler = (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
  log: WorkflowLogger,
) => void | Promise<void>;

export type ToolAfterHandler = (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
  log: WorkflowLogger,
) => void | Promise<void>;

// ─── injectAfterWrite ─────────────────────────────────────────────────────────

export interface AfterWriteContext {
  /** Which write tool was used. */
  tool: "write" | "edit" | "patch" | "multiedit";
  /** File paths that were modified. */
  filePaths: string[];
  /** The original tool output string. */
  originalOutput: string;
  /** Session ID. */
  sessionID: string;
  /** Shared utilities. */
  utils: WorkflowUtils;
}

export type AfterWriteHandler = (
  ctx: AfterWriteContext,
) => Promise<string | undefined>;

// ─── Tool Factory ─────────────────────────────────────────────────────────────

/**
 * A function that creates a tool definition.
 * Returns a readonly [name, definition] tuple, matching the existing pattern.
 */
export type ToolFactory = (
  config: DevToolsConfig,
  root: string,
  $: any,
) => readonly [string, any];

// ─── Helper: Parse Work Item ID ───────────────────────────────────────────────

/** Parse a work item ID from a string (numeric or Azure DevOps URL). */
export const parseWorkItemId = (input: string | undefined | null): string | null => {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/[?&]workitem=(\d+)/i);
  if (match) return match[1];
  return null;
};
