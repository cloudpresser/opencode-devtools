import { tool } from "@opencode-ai/plugin";

// ─── Types matching the real `opencode export` JSON format ────────────────────

interface ToolState {
  tool?: string;
  input?: any;
  output?: string;
  error?: string;
  metadata?: any;
}

interface MessagePart {
  type: string;
  text?: string;
  state?: ToolState;
  id?: string;
  sessionID?: string;
  messageID?: string;
}

interface MessageInfo {
  role: "user" | "assistant";
  agent?: string;
  cost?: number;
  tokens?: { input: number; output: number };
  model?: string;
  finishReason?: string;
  time?: { start?: string; end?: string };
}

interface Message {
  info: MessageInfo;
  parts: MessagePart[];
}

interface SessionInfo {
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

interface SessionExport {
  info: SessionInfo;
  messages: Message[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatToolCall(part: MessagePart): string {
  const name = part.state?.tool || "unknown";
  let argsSummary = "";
  if (part.state?.input) {
    const args =
      typeof part.state.input === "string"
        ? part.state.input
        : JSON.stringify(part.state.input);
    argsSummary = args.length > 200 ? args.slice(0, 200) + "..." : args;
  }
  return `${name}(${argsSummary})`;
}

function formatToolResult(part: MessagePart, maxLen: number): string {
  const result = part.state?.output || part.state?.error || "";
  if (result.length <= maxLen) return result;
  return result.slice(0, maxLen) + `... (${result.length} chars total)`;
}

function computeDuration(messages: Message[]): string {
  let earliest: string | undefined;
  let latest: string | undefined;
  for (const msg of messages) {
    const start = msg.info.time?.start;
    const end = msg.info.time?.end;
    if (start && (!earliest || start < earliest)) earliest = start;
    if (end && (!latest || end > latest)) latest = end;
  }
  if (!earliest || !latest) return "unknown";
  const ms = new Date(latest).getTime() - new Date(earliest).getTime();
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

export function analyzeSession(data: SessionExport, verbose: boolean): string {
  const sections: string[] = [];
  const { info, messages } = data;

  // Header
  sections.push(`## Session: ${info.id}`);
  if (info.title) sections.push(`**Title:** ${info.title}`);
  if (info.directory) sections.push(`**Directory:** ${info.directory}`);
  if (info.version) sections.push(`**Version:** ${info.version}`);
  if (info.parentID) sections.push(`**Parent:** ${info.parentID}`);
  sections.push("");

  // Stats
  let totalCost = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const toolUsage: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};

  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      assistantTurns++;
      if (msg.info.cost) totalCost += msg.info.cost;
      if (msg.info.tokens) {
        totalTokensInput += msg.info.tokens.input || 0;
        totalTokensOutput += msg.info.tokens.output || 0;
      }
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state?.tool) {
          toolCalls++;
          const toolName = part.state.tool;
          toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
          if (part.state.error) {
            toolErrors++;
            toolFailures[toolName] = (toolFailures[toolName] || 0) + 1;
          }
        }
      }
    }
  }

  const duration = computeDuration(messages);
  const totalTokens = totalTokensInput + totalTokensOutput;

  sections.push("## Stats");
  sections.push(`- **Duration:** ${duration}`);
  sections.push(`- **Turns:** ${assistantTurns}`);
  sections.push(`- **Tool calls:** ${toolCalls}${toolErrors > 0 ? ` (${toolErrors} errors)` : ""}`);
  sections.push(`- **Total cost:** $${totalCost.toFixed(2)}`);
  sections.push(
    `- **Total tokens:** ${totalTokens.toLocaleString()} (${totalTokensInput.toLocaleString()} in / ${totalTokensOutput.toLocaleString()} out)`,
  );
  sections.push("");

  // Tool usage breakdown
  if (Object.keys(toolUsage).length > 0) {
    sections.push("## Tool Usage");
    const sorted = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      const failures = toolFailures[name];
      const failStr = failures ? ` (${failures} failed)` : "";
      sections.push(`- ${name}: ${count}${failStr}`);
    }
    sections.push("");
  }

  // Timeline
  sections.push("## Timeline");
  let turnNum = 0;
  for (const msg of messages) {
    if (msg.info.role === "user") {
      // Summarize user message
      const texts = msg.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!);
      const combined = texts.join(" ");
      const preview =
        combined.length > 300
          ? combined.slice(0, 300) + "..."
          : combined;
      sections.push(`### User`);
      sections.push(preview);
      sections.push("");
    } else if (msg.info.role === "assistant") {
      turnNum++;
      const costStr = msg.info.cost ? `$${msg.info.cost.toFixed(3)}` : "";
      const finishStr = msg.info.finishReason || "";
      const agentStr = msg.info.agent ? `[${msg.info.agent}]` : "";

      sections.push(
        `### Turn ${turnNum} ${[agentStr, costStr, finishStr].filter(Boolean).join(" · ")}`,
      );

      // Text parts
      const textParts = msg.parts.filter(
        (p) => p.type === "text" && p.text,
      );
      if (textParts.length > 0) {
        for (const p of textParts) {
          const text = p.text!;
          if (verbose || text.length <= 500) {
            sections.push(text);
          } else {
            sections.push(text.slice(0, 500) + "...");
          }
        }
      }

      // Tool calls
      const tools = msg.parts.filter(
        (p) => p.type === "tool" && p.state?.tool,
      );
      if (tools.length > 0) {
        sections.push("**Tool calls:**");
        for (const t of tools) {
          const prefix = t.state?.error ? "❌ " : "";
          sections.push(`- ${prefix}\`${formatToolCall(t)}\``);
          if (verbose && t.state?.output) {
            sections.push(
              `  Result: ${formatToolResult(t, 500)}`,
            );
          }
          if (t.state?.error) {
            sections.push(`  Error: ${t.state.error.slice(0, 300)}`);
          }
        }
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export function createSessionAnalysisTool($: any) {
  return [
    "session-analysis",
    tool({
      description:
        "Analyze an OpenCode session by ID. Retrieves the full session " +
        "transcript via `opencode export` and produces a structured summary " +
        "including stats, tool usage, timeline, and any issues detected.",
      args: {
        sessionId: tool.schema
          .string()
          .describe("The session ID to analyze (e.g. ses_abc123...)"),
        verbose: tool.schema
          .optional(tool.schema.boolean())
          .describe(
            "Include full tool results and untruncated text (default false)",
          ),
      },
      async execute(args) {
        const { sessionId, verbose = false } = args;

        // Export the session via CLI
        let rawJson: string;
        try {
          rawJson = (
            await $`opencode export ${sessionId}`.text()
          ).trim();
        } catch (e: any) {
          return `Failed to export session ${sessionId}: ${e.message}`;
        }

        if (!rawJson) {
          return `No data returned for session ${sessionId}. The session may not exist.`;
        }

        // Parse the JSON — handle potential non-JSON prefix from CLI output
        let data: SessionExport;
        try {
          data = JSON.parse(rawJson);
        } catch {
          const jsonStart = rawJson.indexOf("{");
          const jsonEnd = rawJson.lastIndexOf("}");
          if (jsonStart === -1 || jsonEnd === -1) {
            return `Failed to parse session export. Raw output:\n${rawJson.slice(0, 500)}`;
          }
          try {
            data = JSON.parse(rawJson.slice(jsonStart, jsonEnd + 1));
          } catch {
            return `Failed to parse session JSON. Raw output:\n${rawJson.slice(0, 500)}`;
          }
        }

        if (!data.messages || !Array.isArray(data.messages)) {
          return `Session ${sessionId} has no messages. Export structure: ${JSON.stringify(Object.keys(data))}`;
        }

        return analyzeSession(data, verbose);
      },
    }),
  ] as const;
}
