/**
 * Session Resolution — Bridges launcher and worker sessions.
 *
 * When the engine launches a worker, it injects structured metadata
 * into both the launcher and worker session logs:
 *
 *   Launcher: <!-- workflow-metadata: { type: "workflow-launch", ... } -->
 *   Worker:   <!-- worker-metadata: { type: "workflow-worker", ... } -->
 *
 * This module parses those metadata blocks and resolves launcher session
 * IDs to their corresponding worker sessions using the OpenCode SDK API.
 *
 * Resolution is strict: if a launcher session is detected but the
 * corresponding worker session cannot be verified via metadata match,
 * a WorkerSessionNotFoundError is thrown. No guessing.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LauncherMetadata {
  type: "workflow-launch";
  workflowName: string;
  branchName: string;
  baseBranch: string;
  workerArgs: string;
  worktreeDir: string;
  workItemId: string | null;
  agentName: string | null;
  launchedAt: string;
}

export interface WorkerMetadata {
  type: "workflow-worker";
  workflowName: string;
  workerSessionId: string;
  workerArgs: string;
  startedAt: string;
}

export interface SessionResolution {
  /** Whether the provided session ID was a launcher session. */
  isLauncher: boolean;
  /** Parsed launcher metadata (only if isLauncher). */
  launcherMetadata?: LauncherMetadata;
  /** The verified worker session ID. */
  workerSessionId?: string;
  /** The session ID to actually analyze (worker if found, original otherwise). */
  targetSessionId: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a launcher session is detected but the corresponding
 * worker session cannot be found or verified.
 *
 * This is NOT a fallback situation — launcher-only analysis is not
 * useful. The caller should present this error to the user and ask
 * them to provide the worker session ID directly.
 */
export class WorkerSessionNotFoundError extends Error {
  public readonly launcherSessionId: string;
  public readonly launcherMetadata: LauncherMetadata;

  constructor(launcherSessionId: string, launcherMetadata: LauncherMetadata) {
    const msg =
      `Worker session not found for launcher ${launcherSessionId}. ` +
      `Workflow: ${launcherMetadata.workflowName}, ` +
      `Branch: ${launcherMetadata.branchName}, ` +
      `Worktree: ${launcherMetadata.worktreeDir}. ` +
      `The worker may still be running or the session may have been deleted. ` +
      `Provide the worker session ID directly (find it in the tmux window ` +
      `or run \`opencode session list\` in the worktree directory).`;
    super(msg);
    this.name = "WorkerSessionNotFoundError";
    this.launcherSessionId = launcherSessionId;
    this.launcherMetadata = launcherMetadata;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

const LAUNCHER_META_RE = /<!-- workflow-metadata: ({.*?}) -->/;
const WORKER_META_RE = /<!-- worker-metadata: ({.*?}) -->/;

/**
 * Extract launcher metadata from a text string.
 * Returns null if no valid metadata block is found.
 */
export function parseLauncherMetadata(
  text: string,
): LauncherMetadata | null {
  const match = text.match(LAUNCHER_META_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.type === "workflow-launch") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract worker metadata from a text string.
 * Returns null if no valid metadata block is found.
 */
export function parseWorkerMetadata(
  text: string,
): WorkerMetadata | null {
  const match = text.match(WORKER_META_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.type === "workflow-worker") return parsed;
    return null;
  } catch {
    return null;
  }
}

// ─── Session Export ───────────────────────────────────────────────────────────

/**
 * Export a session via `opencode export`. Returns the raw text output.
 */
export async function exportSession(
  sessionId: string,
  $: any,
): Promise<string> {
  return $`opencode export ${sessionId}`.text();
}

/**
 * Extract all text parts from a raw session export JSON string.
 * Handles the nested messages[].parts[].text structure.
 */
function extractTextParts(rawExport: string): string[] {
  try {
    const idx = rawExport.indexOf("{");
    if (idx < 0) return [rawExport];
    const data = JSON.parse(rawExport.slice(idx));
    const texts: string[] = [];
    for (const msg of data.messages || []) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
      }
    }
    return texts.length > 0 ? texts : [rawExport];
  } catch {
    return [rawExport];
  }
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve a session ID to determine if it's a launcher session,
 * and if so, find the corresponding worker session.
 *
 * Uses the OpenCode SDK client API to query sessions by directory,
 * then verifies worker sessions via metadata match.
 *
 * Resolution is strict:
 * - If launcher detected and worker verified via metadata → return worker
 * - If launcher detected but worker NOT found → throw WorkerSessionNotFoundError
 * - If not a launcher → return session directly (no chaining)
 *
 * @param sessionId  The session ID to resolve
 * @param $          Shell for `opencode export` calls
 * @param client     OpenCode SDK client (for session.list + session.messages API)
 */
export async function resolveWorkerSession(
  sessionId: string,
  $: any,
  client?: any,
): Promise<SessionResolution> {
  // 1. Export the session and check for launcher metadata
  let rawExport: string;
  try {
    rawExport = await exportSession(sessionId, $);
  } catch (e: any) {
    // Can't export → treat as direct session (not a launcher)
    return {
      isLauncher: false,
      targetSessionId: sessionId,
    };
  }

  // 2. Parse export, scan text parts for launcher metadata
  const textParts = extractTextParts(rawExport);
  let launcherMeta: LauncherMetadata | null = null;
  for (const text of textParts) {
    launcherMeta = parseLauncherMetadata(text);
    if (launcherMeta) break;
  }

  if (!launcherMeta) {
    // Not a launcher → analyze directly
    return {
      isLauncher: false,
      targetSessionId: sessionId,
    };
  }

  // 3. It's a launcher session — find the worker via SDK API
  if (!client?.session?.list) {
    throw new WorkerSessionNotFoundError(sessionId, launcherMeta);
  }

  let candidates: any[];
  try {
    const result = await client.session.list({
      query: { directory: launcherMeta.worktreeDir },
    });
    candidates = result?.data || result || [];
    if (!Array.isArray(candidates)) candidates = [];
  } catch {
    throw new WorkerSessionNotFoundError(sessionId, launcherMeta);
  }

  // 4. Filter candidates: exclude launcher, filter by timestamp
  const launchTime = new Date(launcherMeta.launchedAt).getTime();
  const filtered = candidates
    .filter((s: any) => s.id !== sessionId)
    .filter((s: any) => {
      // Worker must have been created around or after launch time.
      // SDK Session uses s.time.created (Unix epoch ms); fall back to
      // string-based fields for safety.
      const created =
        s.time?.created ||
        new Date(s.createdAt || s.created || 0).getTime();
      return created >= launchTime - 60_000; // 1 min tolerance
    })
    .sort((a: any, b: any) => {
      // Ascending by creation time (closest to launch first)
      const aTime =
        a.time?.created ||
        new Date(a.createdAt || a.created || 0).getTime();
      const bTime =
        b.time?.created ||
        new Date(b.createdAt || b.created || 0).getTime();
      return aTime - bTime;
    });

  // 5. Strict verification: check each candidate for matching worker-metadata
  const maxCandidates = Math.min(filtered.length, 5);
  for (let i = 0; i < maxCandidates; i++) {
    const candidate = filtered[i];
    try {
      // Fetch first few messages (metadata is in the first user message)
      let messages: any[];
      if (client.session.messages) {
        const msgResult = await client.session.messages({
          path: { id: candidate.id },
          query: { limit: 3 },
        });
        messages = msgResult?.data || msgResult || [];
        if (!Array.isArray(messages)) messages = [];
      } else {
        // Fallback: export via CLI and extract text parts
        const candidateExport = await exportSession(candidate.id, $);
        const texts = extractTextParts(candidateExport);
        // Wrap in a message-like structure for uniform processing below
        messages = [
          { parts: texts.map((t) => ({ type: "text", text: t })) },
        ];
      }

      // Scan message parts for worker-metadata matching this workflow
      for (const msg of messages) {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            const meta = parseWorkerMetadata(part.text);
            if (meta?.workflowName === launcherMeta.workflowName) {
              return {
                isLauncher: true,
                launcherMetadata: launcherMeta,
                workerSessionId: candidate.id,
                targetSessionId: candidate.id,
              };
            }
          }
        }
      }
    } catch {
      // Candidate inspection failed — skip to next
      continue;
    }
  }

  // 6. No verified match → throw
  throw new WorkerSessionNotFoundError(sessionId, launcherMeta);
}
