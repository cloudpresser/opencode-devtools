/**
 * Shared media processing utility for all Superior Workflow commands.
 *
 * ## Architecture
 *
 * This module provides a pipeline for extracting, downloading, and processing
 * media (images/videos) from Azure DevOps work items. It is designed to be
 * called from any `command.execute.before` hook — the results are injected
 * into template placeholders before the first LLM turn, giving the agent
 * rich visual context with zero manual fetching.
 *
 * ## Pipeline
 *
 *   extractMediaUrls(fields, attachments?)
 *     → downloadMedia(refs, tmpDir, $, config?)
 *       → processMedia(downloads, client, config?)
 *         → formatMediaContext(results)
 *
 * ## Pattern: Vision model invocation from plugin hooks
 *
 * The `processMedia` function uses the OpenCode SDK client to invoke a
 * vision-capable model (default: Gemini 3.1 Pro Preview) for each media
 * item. The pattern is:
 *
 *   1. Create a throwaway session: `client.session.create({ body: {} })`
 *   2. Send a sync prompt with model override and file part:
 *      ```
 *      client.session.prompt({
 *        path: { id: session.id },
 *        body: {
 *          model: { providerID: "google", modelID: "gemini-3.1-pro-preview" },
 *          parts: [
 *            { type: "text", text: "<vision prompt>" },
 *            { type: "file", mime: "image/png", url: "file:///path/to/file" },
 *          ],
 *        },
 *      })
 *      ```
 *   3. Extract text from `response.data.parts`
 *   4. Delete the session: `client.session.delete({ path: { id } })`
 *
 * If `file://` URLs are not supported, the fallback is base64 data URLs:
 *   `data:image/png;base64,<encoded>`
 *
 * This pattern was informed by the subtask2 plugin's use of
 * `client.session.promptAsync()` with model overrides (split "provider/model"
 * into `{ providerID, modelID }`). The key difference: we use the synchronous
 * `prompt()` instead of `promptAsync()` because we need the response text
 * within the hook, before template injection.
 *
 * ## Configuration
 *
 * Media processing is configured via `MediaConfig` in `.devtools.jsonc`:
 * ```jsonc
 * {
 *   "media": {
 *     "enabled": true,          // default: true
 *     "maxFileSize": 52428800,  // default: 50 MB
 *     "model": "gemini-3.1-pro-preview",
 *     "provider": "google"
 *   }
 * }
 * ```
 *
 * @module
 */

import { join, extname } from "node:path";
import { readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { MediaConfig, WorkItemAttachment } from "../providers/types";

// ─── Azure DevOps Constants ──────────────────────────────────────────────────

/**
 * Azure DevOps AAD resource ID. Required by `az rest` to acquire the
 * correct auth token for DevOps API calls. Without this, `az rest`
 * silently returns an HTML login page instead of the actual content.
 */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_PROVIDER = "google";
const DEFAULT_MAX_FILE_SIZE = 52_428_800; // 50 MB

/**
 * Minimum file size in bytes. Downloads smaller than this are likely
 * the Azure DevOps HTML login page returned when auth is missing
 * (the `--resource` flag was omitted or the token expired).
 */
const MIN_VALID_FILE_SIZE = 20_480; // 20 KB

// ─── HTML Fields Containing Media ────────────────────────────────────────────

/** Azure DevOps work item fields that may contain inline `<img>` tags. */
const HTML_MEDIA_FIELDS = [
  "System.Description",
  "Microsoft.VSTS.TCM.Steps",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.TestingDetails",
  "Custom.TestingDetails",
];

// ─── Vision Prompts ──────────────────────────────────────────────────────────

const IMAGE_PROMPT = [
  "Describe this screenshot from a software QA work item.",
  "Focus on:",
  "- UI elements visible and their state",
  "- Any error messages, warnings, or visual defects",
  "- Text content shown on screen",
  "- Anything that appears incorrect, broken, or noteworthy",
  "Be specific about locations (top/bottom/left/right) and element types.",
  "Keep the description concise but thorough (3-8 sentences).",
].join(" ");

const VIDEO_PROMPT = [
  "Summarize this screen recording from a software QA work item.",
  "Describe:",
  "- The sequence of user interactions (clicks, taps, scrolls)",
  "- What changes on screen at each step",
  "- Any UI issues, visual defects, or error states observed",
  "- The final state of the screen",
  "Be specific about the order of events and any problems visible.",
  "Keep the summary concise but thorough.",
].join(" ");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MediaReference {
  /** Azure DevOps attachment API URL */
  url: string;
  /** Display name (filename or auto-generated) */
  name: string;
  /** Where the media was found (field name or "AttachedFile") */
  source: string;
  /** Inferred MIME type from URL extension (may be overridden after download) */
  mimeType?: string;
}

export interface MediaDownloadResult {
  ref: MediaReference;
  /** Absolute path to the downloaded file */
  localPath: string;
  /** Actual MIME type detected by `file --mime-type` */
  fileType: string;
  /** File size in bytes */
  fileSize: number;
  success: boolean;
  error?: string;
}

export interface MediaProcessResult {
  ref: MediaReference;
  /** Human-readable description of the media content (from vision model) */
  description: string;
  /** Whether the media was successfully processed by the vision model */
  processed: boolean;
  /** Path to the local file (for reference) */
  localPath?: string;
}

// ─── MIME Type Helpers ───────────────────────────────────────────────────────

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const VIDEO_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/x-matroska",
]);

function inferMimeFromUrl(url: string): string | undefined {
  // Try ?fileName= query param first
  const fileNameMatch = url.match(/[?&]fileName=([^&]+)/i);
  if (fileNameMatch) {
    const ext = extname(fileNameMatch[1]).toLowerCase();
    if (EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];
  }
  // Try URL path extension
  const pathMatch = url.match(/\/([^/?]+)$/);
  if (pathMatch) {
    const ext = extname(pathMatch[1]).toLowerCase();
    if (EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];
  }
  return undefined;
}

function inferNameFromUrl(url: string, index: number): string {
  const fileNameMatch = url.match(/[?&]fileName=([^&]+)/i);
  if (fileNameMatch) return decodeURIComponent(fileNameMatch[1]);
  const pathMatch = url.match(/\/([^/?]+)$/);
  if (pathMatch && extname(pathMatch[1])) return pathMatch[1];
  return `media-${index}`;
}

// ─── 1. Extract Media URLs ───────────────────────────────────────────────────

/**
 * Extract media URLs from work item HTML fields and AttachedFile relations.
 *
 * Scans known HTML fields for inline `<img src="...">` tags and merges
 * them with any `AttachedFile` relations from the work item. Results are
 * deduplicated by URL.
 *
 * @param fields  Raw work item fields (`System.Description`, `TCM.Steps`, etc.)
 * @param attachments  Optional `AttachedFile` relations from `WorkItemResult`
 * @returns Deduplicated array of media references
 */
export function extractMediaUrls(
  fields: Record<string, any>,
  attachments?: WorkItemAttachment[],
): MediaReference[] {
  const seen = new Set<string>();
  const refs: MediaReference[] = [];

  // 1. Extract inline <img src="..."> from HTML fields
  for (const fieldName of HTML_MEDIA_FIELDS) {
    const html = fields[fieldName];
    if (!html || typeof html !== "string") continue;

    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
    let match: RegExpExecArray | null;
    let fieldIndex = 0;
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (seen.has(url)) continue;
      seen.add(url);

      const shortField = fieldName.replace(/^(Microsoft\.VSTS\.|Custom\.|System\.)/, "");
      refs.push({
        url,
        name: inferNameFromUrl(url, fieldIndex++),
        source: shortField,
        mimeType: inferMimeFromUrl(url),
      });
    }
  }

  // 2. Include AttachedFile relations
  if (attachments) {
    for (const att of attachments) {
      if (seen.has(att.url)) continue;
      seen.add(att.url);

      refs.push({
        url: att.url,
        name: att.name,
        source: "AttachedFile",
        mimeType: inferMimeFromUrl(att.url) || inferMimeFromUrl(att.name),
      });
    }
  }

  return refs;
}

// ─── 2. Download Media ───────────────────────────────────────────────────────

/**
 * Download media files from Azure DevOps attachment URLs.
 *
 * Uses `az rest --resource <AZURE_DEVOPS_RESOURCE>` to authenticate. Without
 * the `--resource` flag, `az rest` silently returns an HTML login page.
 *
 * After download, validates:
 * - File size > 20 KB (rejects likely HTML login pages)
 * - File size < maxFileSize (skips oversized files)
 * - Detects actual MIME type via `file --mime-type`
 *
 * @param refs      Media references from `extractMediaUrls`
 * @param tmpDir    Directory to download files into
 * @param $         Bun shell
 * @param config    Optional media config for size limits
 */
export async function downloadMedia(
  refs: MediaReference[],
  tmpDir: string,
  $: any,
  config?: MediaConfig,
): Promise<MediaDownloadResult[]> {
  if (refs.length === 0) return [];

  const maxSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  await $`mkdir -p ${tmpDir}`.nothrow().quiet();

  const results: MediaDownloadResult[] = [];

  for (const ref of refs) {
    const safeName = ref.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputPath = join(tmpDir, safeName);

    try {
      const dlResult =
        await $`az rest --method get --url ${ref.url} --resource ${AZURE_DEVOPS_RESOURCE} --output-file ${outputPath} 2>&1`
          .nothrow()
          .quiet();

      if (dlResult.exitCode !== 0) {
        const stderr =
          dlResult.stderr?.toString() || dlResult.stdout?.toString() || "";
        const isAuthError =
          stderr.includes("AADSTS") ||
          stderr.includes("unauthorized") ||
          stderr.includes("401");

        results.push({
          ref,
          localPath: outputPath,
          fileType: "unknown",
          fileSize: 0,
          success: false,
          error: isAuthError
            ? [
                "Authentication expired. Fix with:",
                "  - `az login` — refresh interactive browser auth",
                "  - `az account get-access-token` — check token status",
                "  - Generate a new PAT at your Azure DevOps org `_usersSettings/tokens`",
              ].join("\n")
            : stderr.slice(0, 300),
        });
        continue;
      }

      // Validate download
      if (!existsSync(outputPath)) {
        results.push({
          ref,
          localPath: outputPath,
          fileType: "unknown",
          fileSize: 0,
          success: false,
          error: "File not found after download",
        });
        continue;
      }

      const fileSize = statSync(outputPath).size;

      // Reject suspiciously small files (likely HTML login pages)
      if (fileSize < MIN_VALID_FILE_SIZE) {
        const content = readFileSync(outputPath, "utf-8").slice(0, 200);
        const isHtmlPage =
          content.includes("<!DOCTYPE") ||
          content.includes("<html") ||
          content.includes("Sign in");
        unlinkSync(outputPath);
        results.push({
          ref,
          localPath: outputPath,
          fileType: "unknown",
          fileSize,
          success: false,
          error: isHtmlPage
            ? [
                "Downloaded file is an HTML login page, not the actual attachment.",
                "This usually means the Azure DevOps auth token has expired.",
                "Fix: run `az login` to refresh credentials.",
              ].join(" ")
            : `File too small (${fileSize} bytes) — may not be valid media`,
        });
        continue;
      }

      // Reject oversized files
      if (fileSize > maxSize) {
        unlinkSync(outputPath);
        results.push({
          ref,
          localPath: outputPath,
          fileType: "unknown",
          fileSize,
          success: false,
          error: `File too large (${(fileSize / 1_048_576).toFixed(1)} MB) — exceeds ${(maxSize / 1_048_576).toFixed(0)} MB limit`,
        });
        continue;
      }

      // Detect actual MIME type
      let fileType = ref.mimeType || "application/octet-stream";
      try {
        const mimeResult =
          await $`file --mime-type -b ${outputPath}`.text();
        const detected = mimeResult.trim();
        if (detected && detected !== "application/octet-stream") {
          fileType = detected;
        }
      } catch {
        // Fall back to inferred type
      }

      results.push({
        ref,
        localPath: outputPath,
        fileType,
        fileSize,
        success: true,
      });
    } catch (e: any) {
      results.push({
        ref,
        localPath: outputPath,
        fileType: "unknown",
        fileSize: 0,
        success: false,
        error: e.message,
      });
    }
  }

  return results;
}

// ─── 3. Process Media with Vision Model ──────────────────────────────────────

/**
 * Process downloaded media files with a vision-capable model.
 *
 * Creates a throwaway OpenCode session for each media item, sends the
 * file with a vision prompt, and extracts the text description. Sessions
 * are deleted after use to avoid clutter.
 *
 * ## Pattern: Invoking a specific model from a plugin hook
 *
 * ```ts
 * // 1. Create a throwaway session
 * const session = await client.session.create({ body: {} });
 *
 * // 2. Send prompt with model override + file
 * const response = await client.session.prompt({
 *   path: { id: session.data.id },
 *   body: {
 *     model: { providerID: "google", modelID: "gemini-3.1-pro-preview" },
 *     parts: [
 *       { type: "text", text: "Describe this image..." },
 *       { type: "file", mime: "image/png", url: "file:///path/to/img.png" },
 *     ],
 *   },
 * });
 *
 * // 3. Extract text from response
 * const text = response.data.parts
 *   .filter(p => p.type === "text")
 *   .map(p => p.text)
 *   .join("\n");
 *
 * // 4. Clean up
 * await client.session.delete({ path: { id: session.data.id } });
 * ```
 *
 * The model override format `{ providerID, modelID }` follows the pattern
 * established by the subtask2 plugin for splitting "provider/model" strings.
 *
 * @param downloads  Successful download results from `downloadMedia`
 * @param client     OpenCode SDK client (from plugin input)
 * @param config     Optional media config for model selection
 */
export async function processMedia(
  downloads: MediaDownloadResult[],
  client: any,
  config?: MediaConfig,
): Promise<MediaProcessResult[]> {
  const successful = downloads.filter((d) => d.success);
  if (successful.length === 0) {
    // Return error descriptions for failed downloads
    return downloads
      .filter((d) => !d.success)
      .map((d) => ({
        ref: d.ref,
        description: `Download failed: ${d.error}`,
        processed: false,
      }));
  }

  const modelID = config?.model ?? DEFAULT_MODEL;
  const providerID = config?.provider ?? DEFAULT_PROVIDER;

  const results: MediaProcessResult[] = [];

  for (const dl of downloads) {
    if (!dl.success) {
      results.push({
        ref: dl.ref,
        description: `Download failed: ${dl.error}`,
        processed: false,
      });
      continue;
    }

    const isImage = IMAGE_MIMES.has(dl.fileType);
    const isVideo = VIDEO_MIMES.has(dl.fileType);

    if (!isImage && !isVideo) {
      results.push({
        ref: dl.ref,
        description: `${dl.ref.name} (${dl.fileType}, ${formatBytes(dl.fileSize)}) — unsupported media type, not processed`,
        processed: false,
        localPath: dl.localPath,
      });
      continue;
    }

    // Attempt vision processing
    try {
      const description = await invokeVisionModel(
        client,
        dl.localPath,
        dl.fileType,
        isVideo ? VIDEO_PROMPT : IMAGE_PROMPT,
        providerID,
        modelID,
      );

      results.push({
        ref: dl.ref,
        description,
        processed: true,
        localPath: dl.localPath,
      });
    } catch (e: any) {
      results.push({
        ref: dl.ref,
        description: `Vision processing failed: ${e.message}. File saved at ${dl.localPath}`,
        processed: false,
        localPath: dl.localPath,
      });
    }
  }

  return results;
}

/**
 * Invoke the vision model via the OpenCode SDK client.
 *
 * Tries `file://` URL first, then falls back to base64 data URL if that
 * fails. Creates a throwaway session and deletes it after use.
 */
async function invokeVisionModel(
  client: any,
  filePath: string,
  mimeType: string,
  prompt: string,
  providerID: string,
  modelID: string,
): Promise<string> {
  let sessionId: string | undefined;

  try {
    // Create throwaway session
    const session = await client.session.create({ body: {} });
    sessionId = session.data?.id;
    if (!sessionId) throw new Error("Failed to create session");

    // Try file:// URL first
    let response: any;
    try {
      response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          parts: [
            { type: "text" as const, text: prompt },
            {
              type: "file" as const,
              mime: mimeType,
              url: `file://${filePath}`,
            },
          ],
        },
      });
    } catch (fileUrlError: any) {
      // Fallback: base64 data URL
      const fileBuffer = readFileSync(filePath);
      const base64 = fileBuffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64}`;

      response = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          parts: [
            { type: "text" as const, text: prompt },
            { type: "file" as const, mime: mimeType, url: dataUrl },
          ],
        },
      });
    }

    // Extract text from response parts
    const parts: any[] = response?.data?.parts || [];
    const textParts = parts
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text);

    if (textParts.length === 0) {
      throw new Error("Vision model returned no text response");
    }

    return textParts.join("\n");
  } finally {
    // Clean up throwaway session
    if (sessionId) {
      await client.session
        .delete({ path: { id: sessionId } })
        .catch(() => {});
    }
  }
}

// ─── 4. Format Media Context ─────────────────────────────────────────────────

/**
 * Format processed media results into markdown for template injection.
 *
 * Returns an empty string if there are no results, so templates don't
 * get an empty `## Media Context` section.
 *
 * @param results  Processed results from `processMedia`
 * @returns Markdown string, or empty string if no media
 */
export function formatMediaContext(
  results: MediaProcessResult[],
): string {
  if (results.length === 0) return "";

  const lines: string[] = ["## Media Context (auto-processed)", ""];

  for (const r of results) {
    const sourceLabel =
      r.ref.source === "AttachedFile"
        ? "attachment"
        : `from ${r.ref.source}`;

    lines.push(`### ${r.ref.name} (${sourceLabel})`);

    if (r.processed) {
      // Indent description as blockquote for visual separation
      const quoted = r.description
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      lines.push(quoted);
    } else {
      lines.push(`> ${r.description}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
