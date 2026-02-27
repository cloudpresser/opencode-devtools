/**
 * Shared session export parsing utilities for meta-workflows.
 *
 * Provides consistent parsing of `opencode export` JSON output
 * matching the real export format (info.role, state.tool, etc.).
 * Used by create-workflow and iterate-workflow for session analysis.
 */

// ─── Types matching the real `opencode export` JSON format ────────────────────

export interface SessionExportInfo {
  id: string;
  slug?: string;
  title?: string;
  directory?: string;
  version?: string;
  parentID?: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: {
    filesChanged?: number;
    tokensUsed?: number;
    cost?: number;
    duration?: number;
  };
}

export interface MessageInfo {
  role: "user" | "assistant";
  agent?: string;
  cost?: number;
  tokens?: { input: number; output: number };
  model?: string;
  finishReason?: string;
  time?: { start?: string; end?: string };
}

export interface ToolState {
  tool?: string;
  input?: any;
  output?: string;
  error?: string;
  metadata?: any;
}

export interface MessagePart {
  type: string;
  text?: string;
  state?: ToolState;
}

export interface ExportMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

export interface SessionExport {
  info: SessionExportInfo;
  messages: ExportMessage[];
}

// ─── JSON Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse the raw output from `opencode export`, handling potential
 * non-JSON prefix from CLI output.
 */
export function parseExportJson(raw: string): SessionExport | null {
  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Export a session and parse the JSON.
 */
export async function exportAndParse(
  sessionId: string,
  $: any,
): Promise<SessionExport | null> {
  try {
    const raw = await $`opencode export ${sessionId}`.text();
    return parseExportJson(raw);
  } catch {
    return null;
  }
}

// ─── Analysis: Workflow Creation ──────────────────────────────────────────────

/**
 * Analyze a session export for workflow creation context.
 * Produces a focused summary of tools used, errors, and user intent.
 */
export function analyzeForWorkflowCreation(data: SessionExport): string {
  const { messages } = data;
  let assistantTurns = 0;
  let toolCalls = 0;
  const toolUsage: Record<string, number> = {};
  let totalCost = 0;
  const userMessages: string[] = [];
  const errors: string[] = [];
  const commandsUsed: string[] = [];

  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      assistantTurns++;
      totalCost += msg.info.cost || 0;
    }

    if (msg.info.role === "user") {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) {
          userMessages.push(part.text.trim().slice(0, 200));
          const cmdMatch = part.text.match(/^\/(\S+)/);
          if (cmdMatch) commandsUsed.push(cmdMatch[0]);
        }
      }
    }

    for (const part of msg.parts) {
      if (part.type === "tool" && part.state?.tool) {
        toolCalls++;
        const name = part.state.tool;
        toolUsage[name] = (toolUsage[name] || 0) + 1;
        if (part.state.error) {
          errors.push(`${name}: ${String(part.state.error).slice(0, 150)}`);
        }
      }
    }
  }

  const sortedTools = Object.entries(toolUsage)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  - ${name}: ${count}`)
    .join("\n");

  let summary = `## Session Analysis: ${data.info.id}\n\n`;
  summary += `- **Assistant turns**: ${assistantTurns}\n`;
  summary += `- **Tool calls**: ${toolCalls}\n`;
  summary += `- **Total cost**: $${totalCost.toFixed(4)}\n`;
  summary += `- **Commands used**: ${commandsUsed.join(", ") || "none"}\n\n`;
  summary += `### Tool Usage\n${sortedTools || "  (none)"}\n\n`;

  if (errors.length > 0) {
    summary += `### Errors Encountered\n`;
    for (const err of errors) summary += `  - ${err}\n`;
    summary += "\n";
  }

  if (userMessages.length > 0) {
    summary += `### User Messages (first 5)\n`;
    for (const msg of userMessages.slice(0, 5)) summary += `> ${msg}\n\n`;
  }

  summary +=
    "\n> Use the `session-analysis` tool with this session ID to drill into specific parts of the timeline.\n";
  return summary;
}

// ─── Analysis: Workflow Iteration ─────────────────────────────────────────────

/**
 * Analyze a session export for iteration insights.
 * Produces a detailed summary with tool failure analysis, repeated patterns,
 * and efficiency metrics.
 */
export function analyzeForIteration(data: SessionExport): string {
  const { messages } = data;
  let assistantTurns = 0;
  let toolCalls = 0;
  const toolUsage: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const errors: string[] = [];
  const userMessages: string[] = [];
  const toolSequences: string[] = [];

  // Compute duration from message timestamps
  let earliest: string | undefined;
  let latest: string | undefined;

  for (const msg of messages) {
    const start = msg.info.time?.start;
    const end = msg.info.time?.end;
    if (start && (!earliest || start < earliest)) earliest = start;
    if (end && (!latest || end > latest)) latest = end;

    if (msg.info.role === "assistant") {
      assistantTurns++;
      totalCost += msg.info.cost || 0;
      if (msg.info.tokens) {
        totalTokensIn += msg.info.tokens.input || 0;
        totalTokensOut += msg.info.tokens.output || 0;
      }
    }

    if (msg.info.role === "user") {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text?.trim()) {
          userMessages.push(part.text.trim().slice(0, 300));
        }
      }
    }

    for (const part of msg.parts) {
      if (part.type === "tool" && part.state?.tool) {
        const name = part.state.tool;
        toolCalls++;
        toolUsage[name] = (toolUsage[name] || 0) + 1;
        toolSequences.push(name);

        if (part.state.error) {
          toolFailures[name] = (toolFailures[name] || 0) + 1;
          errors.push(`${name}: ${String(part.state.error).slice(0, 200)}`);
        }
      }
    }
  }

  // Duration
  let durationStr = "unknown";
  if (earliest && latest) {
    const ms = new Date(latest).getTime() - new Date(earliest).getTime();
    if (ms < 60_000) durationStr = `${(ms / 1000).toFixed(1)}s`;
    else if (ms < 3_600_000) durationStr = `${(ms / 60_000).toFixed(1)}m`;
    else durationStr = `${(ms / 3_600_000).toFixed(1)}h`;
  }

  const sortedTools = Object.entries(toolUsage)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => {
      const fails = toolFailures[name] || 0;
      return `  - ${name}: ${count} calls${fails ? ` (${fails} failed)` : ""}`;
    })
    .join("\n");

  // Detect repeated patterns
  const repeatedPatterns: string[] = [];
  let runLength = 1;
  for (let i = 1; i < toolSequences.length; i++) {
    if (toolSequences[i] === toolSequences[i - 1]) {
      runLength++;
    } else {
      if (runLength >= 3) {
        repeatedPatterns.push(
          `${toolSequences[i - 1]} called ${runLength} times consecutively`,
        );
      }
      runLength = 1;
    }
  }
  if (runLength >= 3) {
    repeatedPatterns.push(
      `${toolSequences[toolSequences.length - 1]} called ${runLength} times consecutively`,
    );
  }

  const totalTokens = totalTokensIn + totalTokensOut;

  let summary = `## Session Analysis: ${data.info.id}\n\n`;
  summary += `| Metric | Value |\n|--------|-------|\n`;
  summary += `| Duration | ${durationStr} |\n`;
  summary += `| Assistant turns | ${assistantTurns} |\n`;
  summary += `| Tool calls | ${toolCalls} |\n`;
  summary += `| Total cost | $${totalCost.toFixed(4)} |\n`;
  summary += `| Total tokens | ${totalTokens.toLocaleString()} (${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out) |\n`;
  summary += "\n";

  summary += `### Tool Usage\n${sortedTools || "  (none)"}\n\n`;

  if (Object.keys(toolFailures).length > 0) {
    summary += `### Tool Failures\n`;
    for (const [name, count] of Object.entries(toolFailures)) {
      summary += `  - **${name}**: ${count} failure(s)\n`;
    }
    summary += "\n";
  }

  if (repeatedPatterns.length > 0) {
    summary += `### Repeated Patterns (potential inefficiency)\n`;
    for (const p of repeatedPatterns) summary += `  - ${p}\n`;
    summary += "\n";
  }

  if (errors.length > 0) {
    summary += `### Errors (first 10)\n`;
    for (const err of errors.slice(0, 10)) summary += `  - ${err}\n`;
    summary += "\n";
  }

  if (userMessages.length > 0) {
    summary += `### User Messages\n`;
    for (const msg of userMessages.slice(0, 10)) summary += `> ${msg}\n\n`;
  }

  summary +=
    "\n> Use the `session-analysis` tool with verbose mode to drill into specific turns.\n";
  return summary;
}
