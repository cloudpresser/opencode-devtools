#!/usr/bin/env bun
/**
 * extract-session.ts
 *
 * Extracts a readable conversation summary from an OpenCode session.
 *
 * Usage:
 *   bun run scripts/extract-session.ts <sessionID | shareURL>
 *
 * Examples:
 *   bun run scripts/extract-session.ts ses_36a518254ffeEIBuadNp2hdXTR
 *   bun run scripts/extract-session.ts https://opncd.ai/share/Np2hdXTR
 *   bun run scripts/extract-session.ts Np2hdXTR
 */

import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types (mirroring the OpenCode session export JSON)
// ---------------------------------------------------------------------------

interface SessionInfo {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  summary?: { additions: number; deletions: number; files: number };
  share?: { url: string };
  time: { created: number; updated: number };
}

interface ToolState {
  status: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end: number };
}

interface Part {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolState;
  ignored?: boolean;
  snapshot?: string;
  reason?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
  // patch parts
  hash?: string;
  files?: string[];
}

interface MessageInfo {
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  mode?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: Record<string, unknown>;
  finish?: string;
  error?: { name: string; data?: Record<string, unknown> };
  parentID?: string;
  id: string;
  sessionID: string;
  summary?: { diffs?: unknown[] };
}

interface Message {
  info: MessageInfo;
  parts: Part[];
}

interface Session {
  info: SessionInfo;
  messages: Message[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max = 300): string {
  if (!s) return "(empty)";
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + "...";
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatDuration(startMs: number, endMs: number): string {
  const sec = Math.round((endMs - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function formatCost(cost: number | undefined): string {
  if (!cost) return "";
  return `$${cost.toFixed(4)}`;
}

function toolInputSummary(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const val = typeof v === "string" ? truncate(v, 80) : JSON.stringify(v);
    parts.push(`${k}: ${val}`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

async function resolveSessionId(arg: string): Promise<string> {
  // Already a session ID
  if (arg.startsWith("ses_")) return arg;

  // Share URL: https://opncd.ai/share/XXXX
  let shareId: string;
  const urlMatch = arg.match(/opncd\.ai\/share\/([A-Za-z0-9_-]+)/);
  if (urlMatch) {
    shareId = urlMatch[1];
  } else {
    // Bare share ID
    shareId = arg;
  }

  // Query SQLite DB
  const dbPath = join(homedir(), ".local/share/opencode/opencode.db");
  const proc = Bun.spawn(
    [
      "sqlite3",
      dbPath,
      `SELECT session_id FROM session_share WHERE id = '${shareId}'`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;

  const sessionId = out.trim();
  if (!sessionId) {
    // Try with share_ prefix pattern
    const proc2 = Bun.spawn(
      [
        "sqlite3",
        dbPath,
        `SELECT session_id FROM session_share WHERE id LIKE '%${shareId}%'`,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out2 = await new Response(proc2.stdout).text();
    await proc2.exited;
    const sessionId2 = out2.trim();
    if (!sessionId2) {
      console.error(
        `Could not resolve share ID "${shareId}" to a session.${err ? `\nDB error: ${err}` : ""}`
      );
      process.exit(1);
    }
    return sessionId2;
  }
  return sessionId;
}

async function exportSession(sessionId: string): Promise<Session> {
  const proc = Bun.spawn(["opencode", "export", sessionId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`opencode export failed (exit ${exitCode}):\n${err}`);
    process.exit(1);
  }

  try {
    return JSON.parse(out) as Session;
  } catch {
    console.error("Failed to parse opencode export output as JSON.");
    console.error("First 500 chars:", out.slice(0, 500));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderSession(session: Session): string {
  const lines: string[] = [];

  // Header
  const { info } = session;
  lines.push(`# ${info.title || info.slug || info.id}`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Session ID** | \`${info.id}\` |`);
  lines.push(`| **Slug** | ${info.slug} |`);
  lines.push(`| **Project** | \`${info.directory}\` |`);
  lines.push(
    `| **Created** | ${formatTimestamp(info.time.created)} |`
  );
  lines.push(
    `| **Updated** | ${formatTimestamp(info.time.updated)} |`
  );
  if (info.share?.url) {
    lines.push(`| **Share URL** | ${info.share.url} |`);
  }
  if (info.summary) {
    lines.push(
      `| **Changes** | +${info.summary.additions} -${info.summary.deletions} in ${info.summary.files} file(s) |`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Messages
  let msgIndex = 0;
  for (const msg of session.messages) {
    const { role } = msg.info;
    const mode = msg.info.mode || msg.info.agent || "";
    const cost = msg.info.cost;
    const hasContent = msg.parts.some(
      (p) =>
        (p.type === "text" && p.text?.trim() && !p.ignored) ||
        p.type === "tool" ||
        p.type === "patch"
    );
    if (!hasContent) continue;

    msgIndex++;
    const roleIcon = role === "user" ? "**User**" : "**Assistant**";
    const modeTag = mode ? ` [${mode}]` : "";
    const costTag = cost ? ` | ${formatCost(cost)}` : "";
    const timeTag = msg.info.time.completed
      ? ` | ${formatDuration(msg.info.time.created, msg.info.time.completed)}`
      : "";

    lines.push(`## ${msgIndex}. ${roleIcon}${modeTag}${costTag}${timeTag}`);
    lines.push("");

    for (const part of msg.parts) {
      if (part.type === "text" && part.text?.trim() && !part.ignored) {
        lines.push(part.text.trim());
        lines.push("");
      }

      if (part.type === "tool" && part.state) {
        const { tool } = part;
        const { state } = part;
        const status = state.status === "completed" ? "" : ` (${state.status})`;
        const inputStr = toolInputSummary(state.input);
        const outputStr = state.output
          ? truncate(state.output, 200)
          : state.error
            ? `ERROR: ${truncate(state.error, 150)}`
            : "(no output)";

        lines.push(`> **\`${tool}\`**${status}`);
        lines.push(`> Input: ${truncate(inputStr, 200)}`);
        lines.push(`> Output: ${outputStr}`);
        lines.push("");
      }

      if (part.type === "patch" && part.files) {
        lines.push(
          `> **Patch applied** to ${part.files.length} file(s): ${part.files.map((f) => `\`${f.split("/").slice(-3).join("/")}\``).join(", ")}`
        );
        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
  }

  // Footer stats
  const totalCost = session.messages.reduce(
    (sum, m) => sum + (m.info.cost || 0),
    0
  );
  const assistantMsgs = session.messages.filter(
    (m) => m.info.role === "assistant"
  );
  const toolCalls = session.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool");
  const duration = formatDuration(
    info.time.created,
    info.time.updated
  );

  lines.push("## Summary Stats");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Total messages** | ${session.messages.length} |`);
  lines.push(`| **Assistant turns** | ${assistantMsgs.length} |`);
  lines.push(`| **Tool calls** | ${toolCalls.length} |`);
  lines.push(`| **Total cost** | ${formatCost(totalCost)} |`);
  lines.push(`| **Session duration** | ${duration} |`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: bun run scripts/extract-session.ts <sessionID | shareURL>"
    );
    console.error("");
    console.error("Examples:");
    console.error(
      "  bun run scripts/extract-session.ts ses_36a518254ffeEIBuadNp2hdXTR"
    );
    console.error(
      "  bun run scripts/extract-session.ts https://opncd.ai/share/Np2hdXTR"
    );
    console.error("  bun run scripts/extract-session.ts Np2hdXTR");
    process.exit(1);
  }

  // Check if input is a file path (for piped/pre-exported JSON)
  const isFile = arg.endsWith(".json") || arg.startsWith("/");
  let session: Session;

  if (isFile) {
    const file = Bun.file(arg);
    if (!(await file.exists())) {
      console.error(`File not found: ${arg}`);
      process.exit(1);
    }
    session = (await file.json()) as Session;
  } else {
    const sessionId = await resolveSessionId(arg);
    session = await exportSession(sessionId);
  }

  console.log(renderSession(session));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
