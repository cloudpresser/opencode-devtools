/**
 * Tests for the shared media processing utility (src/tools/media.ts).
 *
 * Unit tests use mocks for az CLI and OpenCode client.
 * Integration tests hit real Azure DevOps (read-only, no gate needed).
 *
 * Run with: bun test e2e/media.test.ts
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractMediaUrls,
  downloadMedia,
  processMedia,
  formatMediaContext,
  type MediaReference,
  type MediaDownloadResult,
  type MediaProcessResult,
} from "../src/tools/media";

// ─── Mock Data ───────────────────────────────────────────────────────────────

const DEVOPS_IMG_URL =
  "https://dev.azure.com/Org/Project/_apis/wit/attachments/abc-123?fileName=screenshot.png";
const DEVOPS_VIDEO_URL =
  "https://dev.azure.com/Org/Project/_apis/wit/attachments/def-456";
const DEVOPS_IMG_URL_2 =
  "https://dev.azure.com/Org/Project/_apis/wit/attachments/ghi-789?fileName=error.jpg";

const HTML_WITH_IMAGES = `
<div>
  <p>Step 1: Open the app</p>
  <img src="${DEVOPS_IMG_URL}" alt="screenshot" />
  <p>Step 2: Tap the button</p>
  <img src="${DEVOPS_IMG_URL_2}" />
</div>
`;

const HTML_NO_IMAGES = `<div><p>Just text, no images.</p></div>`;

const MOCK_ATTACHMENTS = [
  { name: "recording.mp4", url: DEVOPS_VIDEO_URL },
  { name: "screenshot.png", url: DEVOPS_IMG_URL }, // duplicate of inline
];

// ─── extractMediaUrls ────────────────────────────────────────────────────────

describe("extractMediaUrls", () => {
  it("extracts inline <img src> from HTML fields", () => {
    const refs = extractMediaUrls({
      "Microsoft.VSTS.TCM.Steps": HTML_WITH_IMAGES,
    });

    expect(refs).toHaveLength(2);
    expect(refs[0].url).toBe(DEVOPS_IMG_URL);
    expect(refs[0].name).toBe("screenshot.png");
    expect(refs[0].source).toBe("TCM.Steps");
    expect(refs[0].mimeType).toBe("image/png");

    expect(refs[1].url).toBe(DEVOPS_IMG_URL_2);
    expect(refs[1].name).toBe("error.jpg");
    expect(refs[1].mimeType).toBe("image/jpeg");
  });

  it("includes AttachedFile relations", () => {
    const refs = extractMediaUrls({}, MOCK_ATTACHMENTS);

    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe("recording.mp4");
    expect(refs[0].source).toBe("AttachedFile");
    expect(refs[1].name).toBe("screenshot.png");
  });

  it("deduplicates same URL from fields and attachments", () => {
    const refs = extractMediaUrls(
      { "Microsoft.VSTS.TCM.Steps": HTML_WITH_IMAGES },
      MOCK_ATTACHMENTS,
    );

    // 2 from HTML + 1 from attachments (recording.mp4, screenshot.png is a dupe)
    expect(refs).toHaveLength(3);
    const urls = refs.map((r) => r.url);
    expect(new Set(urls).size).toBe(3);
  });

  it("handles empty/null/undefined fields gracefully", () => {
    expect(extractMediaUrls({})).toHaveLength(0);
    expect(extractMediaUrls({ "System.Description": null })).toHaveLength(0);
    expect(extractMediaUrls({ "System.Description": "" })).toHaveLength(0);
    expect(
      extractMediaUrls({ "System.Description": undefined }),
    ).toHaveLength(0);
  });

  it("handles fields with no images", () => {
    const refs = extractMediaUrls({
      "System.Description": HTML_NO_IMAGES,
    });
    expect(refs).toHaveLength(0);
  });

  it("scans all known HTML fields", () => {
    const fields: Record<string, string> = {};
    const knownFields = [
      "System.Description",
      "Microsoft.VSTS.TCM.Steps",
      "Microsoft.VSTS.TCM.ReproSteps",
      "Microsoft.VSTS.Common.AcceptanceCriteria",
      "Microsoft.VSTS.TCM.TestingDetails",
      "Custom.TestingDetails",
    ];
    // Put a unique image in each field
    for (let i = 0; i < knownFields.length; i++) {
      fields[knownFields[i]] =
        `<img src="https://example.com/img${i}.png" />`;
    }
    const refs = extractMediaUrls(fields);
    expect(refs).toHaveLength(knownFields.length);
  });

  it("infers MIME type from ?fileName= query param", () => {
    const refs = extractMediaUrls({
      "System.Description": `<img src="https://devops.example.com/attachments/abc?fileName=test.webp" />`,
    });
    expect(refs[0].mimeType).toBe("image/webp");
  });

  it("infers MIME type from URL path extension", () => {
    const refs = extractMediaUrls({}, [
      { name: "video.mp4", url: "https://example.com/files/video.mp4" },
    ]);
    expect(refs[0].mimeType).toBe("video/mp4");
  });
});

// ─── downloadMedia ───────────────────────────────────────────────────────────

describe("downloadMedia", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "media-test-"));
  });

  // Cleanup after each test
  const cleanup = () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  it("calls az rest with --resource flag for Azure DevOps auth", async () => {
    const mockShell = createMockShell({ exitCode: 0 });

    // Create a fake file so validation passes
    const ref: MediaReference = {
      url: DEVOPS_IMG_URL,
      name: "test.png",
      source: "TCM.Steps",
      mimeType: "image/png",
    };

    // Write a fake downloaded file for validation
    const expectedPath = join(tmpDir, "test.png");
    writeFileSync(expectedPath, Buffer.alloc(25_000)); // > 20KB threshold

    const results = await downloadMedia([ref], tmpDir, mockShell);

    // Verify az rest was called with the resource flag
    // calls[0] is mkdir, calls[1] is az rest
    expect(mockShell.calls.length).toBeGreaterThan(1);
    const azCall = mockShell.calls.find((c: string) => c.includes("az rest"));
    expect(azCall).toBeDefined();
    expect(azCall).toContain("499b84ac-1321-427f-aa17-267ca6975798");

    cleanup();
  });

  it("rejects files smaller than 20KB (likely HTML login page)", async () => {
    const mockShell = createMockShell({ exitCode: 0 });

    const ref: MediaReference = {
      url: DEVOPS_IMG_URL,
      name: "tiny.png",
      source: "TCM.Steps",
    };

    // Write a tiny file that looks like HTML
    const expectedPath = join(tmpDir, "tiny.png");
    writeFileSync(expectedPath, "<!DOCTYPE html><html><body>Sign in</body></html>");

    const results = await downloadMedia([ref], tmpDir, mockShell);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("HTML login page");

    cleanup();
  });

  it("respects maxFileSize limit", async () => {
    const mockShell = createMockShell({ exitCode: 0 });

    const ref: MediaReference = {
      url: DEVOPS_IMG_URL,
      name: "huge.png",
      source: "TCM.Steps",
    };

    // Write a file larger than the limit
    const expectedPath = join(tmpDir, "huge.png");
    writeFileSync(expectedPath, Buffer.alloc(100_000));

    const config = { maxFileSize: 50_000 }; // 50KB limit for test
    const results = await downloadMedia([ref], tmpDir, mockShell, config);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("too large");

    cleanup();
  });

  it("handles download failures with auth error detection", async () => {
    const mockShell = createMockShell({
      exitCode: 1,
      stderr: "AADSTS700082: token expired",
    });

    const ref: MediaReference = {
      url: DEVOPS_IMG_URL,
      name: "fail.png",
      source: "TCM.Steps",
    };

    const results = await downloadMedia([ref], tmpDir, mockShell);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("Authentication expired");
    expect(results[0].error).toContain("az login");

    cleanup();
  });

  it("returns empty array for empty input", async () => {
    const results = await downloadMedia([], tmpDir, $);
    expect(results).toHaveLength(0);
    cleanup();
  });
});

// ─── processMedia ────────────────────────────────────────────────────────────

describe("processMedia", () => {
  let mockClient: any;
  let mockPrompt: ReturnType<typeof mock>;
  let mockCreate: ReturnType<typeof mock>;
  let mockDelete: ReturnType<typeof mock>;

  beforeEach(() => {
    mockPrompt = mock(async () => ({
      data: {
        parts: [
          {
            type: "text",
            text: "The screenshot shows a mobile app with a purchase flow. The header image appears compressed.",
          },
        ],
      },
    }));
    mockCreate = mock(async () => ({
      data: { id: "ses_throwaway_123" },
    }));
    mockDelete = mock(async () => ({}));

    mockClient = {
      session: {
        create: mockCreate,
        prompt: mockPrompt,
        delete: mockDelete,
      },
    };
  });

  it("invokes vision model with correct model override for images", async () => {
    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_IMG_URL,
          name: "screenshot.png",
          source: "TCM.Steps",
        },
        localPath: "/tmp/screenshot.png",
        fileType: "image/png",
        fileSize: 50_000,
        success: true,
      },
    ];

    const results = await processMedia(downloads, mockClient);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);

    // Check model override
    const promptCall = mockPrompt.mock.calls[0] as any[];
    const body = promptCall[0].body;
    expect(body.model.providerID).toBe("google");
    expect(body.model.modelID).toBe("gemini-3.1-pro-preview");

    // Check parts include text + file
    expect(body.parts).toHaveLength(2);
    expect(body.parts[0].type).toBe("text");
    expect(body.parts[1].type).toBe("file");
    expect(body.parts[1].mime).toBe("image/png");
    expect(body.parts[1].url).toContain("file://");

    expect(results).toHaveLength(1);
    expect(results[0].processed).toBe(true);
    expect(results[0].description).toContain("purchase flow");
  });

  it("uses video prompt for video files", async () => {
    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_VIDEO_URL,
          name: "recording.mp4",
          source: "AttachedFile",
        },
        localPath: "/tmp/recording.mp4",
        fileType: "video/mp4",
        fileSize: 5_000_000,
        success: true,
      },
    ];

    const results = await processMedia(downloads, mockClient);

    const promptCall = mockPrompt.mock.calls[0] as any[];
    const textPart = promptCall[0].body.parts[0];
    expect(textPart.text).toContain("screen recording");

    expect(results[0].processed).toBe(true);
  });

  it("skips unsupported file types", async () => {
    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: "https://example.com/doc.pdf",
          name: "doc.pdf",
          source: "AttachedFile",
        },
        localPath: "/tmp/doc.pdf",
        fileType: "application/pdf",
        fileSize: 100_000,
        success: true,
      },
    ];

    const results = await processMedia(downloads, mockClient);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].processed).toBe(false);
    expect(results[0].description).toContain("unsupported media type");
  });

  it("handles vision model failure gracefully", async () => {
    mockPrompt.mockImplementation(async () => {
      throw new Error("Model unavailable");
    });

    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_IMG_URL,
          name: "fail.png",
          source: "TCM.Steps",
        },
        localPath: "/tmp/fail.png",
        fileType: "image/png",
        fileSize: 50_000,
        success: true,
      },
    ];

    const results = await processMedia(downloads, mockClient);

    expect(results).toHaveLength(1);
    expect(results[0].processed).toBe(false);
    expect(results[0].description).toContain("Vision processing failed");
  });

  it("respects custom model config", async () => {
    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_IMG_URL,
          name: "test.png",
          source: "TCM.Steps",
        },
        localPath: "/tmp/test.png",
        fileType: "image/png",
        fileSize: 50_000,
        success: true,
      },
    ];

    await processMedia(downloads, mockClient, {
      model: "custom-vision-model",
      provider: "custom-provider",
    });

    const promptCall = mockPrompt.mock.calls[0] as any[];
    const body = promptCall[0].body;
    expect(body.model.providerID).toBe("custom-provider");
    expect(body.model.modelID).toBe("custom-vision-model");
  });

  it("cleans up throwaway session even on failure", async () => {
    mockPrompt.mockImplementation(async () => {
      throw new Error("Kaboom");
    });

    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_IMG_URL,
          name: "test.png",
          source: "TCM.Steps",
        },
        localPath: "/tmp/test.png",
        fileType: "image/png",
        fileSize: 50_000,
        success: true,
      },
    ];

    await processMedia(downloads, mockClient);

    // Session should still be deleted
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("returns download errors for failed downloads", async () => {
    const downloads: MediaDownloadResult[] = [
      {
        ref: {
          url: DEVOPS_IMG_URL,
          name: "fail.png",
          source: "TCM.Steps",
        },
        localPath: "/tmp/fail.png",
        fileType: "unknown",
        fileSize: 0,
        success: false,
        error: "Auth expired",
      },
    ];

    const results = await processMedia(downloads, mockClient);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].processed).toBe(false);
    expect(results[0].description).toContain("Auth expired");
  });
});

// ─── formatMediaContext ──────────────────────────────────────────────────────

describe("formatMediaContext", () => {
  it("produces correct markdown for processed images", () => {
    const results: MediaProcessResult[] = [
      {
        ref: { url: "u1", name: "screenshot.png", source: "TCM.Steps" },
        description: "A mobile app screen showing a purchase flow.",
        processed: true,
      },
    ];

    const md = formatMediaContext(results);
    expect(md).toContain("## Media Context");
    expect(md).toContain("### screenshot.png");
    expect(md).toContain("from TCM.Steps");
    expect(md).toContain("> A mobile app screen");
  });

  it("labels AttachedFile sources as 'attachment'", () => {
    const results: MediaProcessResult[] = [
      {
        ref: {
          url: "u1",
          name: "recording.mp4",
          source: "AttachedFile",
        },
        description: "Video showing dark mode toggle.",
        processed: true,
      },
    ];

    const md = formatMediaContext(results);
    expect(md).toContain("(attachment)");
  });

  it("returns empty string when no results", () => {
    expect(formatMediaContext([])).toBe("");
  });

  it("includes error descriptions for failed items", () => {
    const results: MediaProcessResult[] = [
      {
        ref: { url: "u1", name: "broken.png", source: "TCM.Steps" },
        description: "Download failed: Auth expired",
        processed: false,
      },
    ];

    const md = formatMediaContext(results);
    expect(md).toContain("Download failed");
  });

  it("handles mixed processed and failed items", () => {
    const results: MediaProcessResult[] = [
      {
        ref: { url: "u1", name: "good.png", source: "TCM.Steps" },
        description: "A screenshot of the settings page.",
        processed: true,
      },
      {
        ref: {
          url: "u2",
          name: "failed.mp4",
          source: "AttachedFile",
        },
        description: "Vision processing failed: timeout",
        processed: false,
      },
    ];

    const md = formatMediaContext(results);
    expect(md).toContain("### good.png");
    expect(md).toContain("settings page");
    expect(md).toContain("### failed.mp4");
    expect(md).toContain("Vision processing failed");
  });
});

// ─── Integration: Real Azure DevOps (read-only) ─────────────────────────────

describe("integration: Azure DevOps media extraction", () => {
  // Defect 69970 has:
  // - 1 inline image in Microsoft.VSTS.TCM.Steps
  // - 1 AttachedFile: LightDarkModeSwitch.mp4 (22MB video)
  const DEFECT_ID = "69970";
  const ORG = "https://dev.azure.com/VectorVest";

  it("extracts inline image URLs from real work item HTML", async () => {
    const result =
      await $`az boards work-item show --id ${DEFECT_ID} --org ${ORG} --output json 2>/dev/null`
        .text()
        .catch(() => "");

    if (!result) {
      console.log("Skipping: az boards not authenticated");
      return;
    }

    const item = JSON.parse(result);
    const fields = item.fields || {};

    const refs = extractMediaUrls(fields);

    // Should find inline image(s) in TCM.Steps
    const stepsRefs = refs.filter((r) => r.source === "TCM.Steps");
    expect(stepsRefs.length).toBeGreaterThan(0);

    // Each ref should have a valid Azure DevOps attachment URL
    for (const ref of stepsRefs) {
      expect(ref.url).toContain("_apis/wit/attachments/");
      expect(ref.mimeType).toBeDefined();
    }
  });

  it("extracts AttachedFile video from real work item relations", async () => {
    const result =
      await $`az boards work-item show --id ${DEFECT_ID} --org ${ORG} --expand Relations --output json 2>/dev/null`
        .text()
        .catch(() => "");

    if (!result) {
      console.log("Skipping: az boards not authenticated");
      return;
    }

    const item = JSON.parse(result);

    // Extract AttachedFile relations (same logic as azure-devops.ts)
    const attachments = (item.relations || [])
      .filter((r: any) => r.rel === "AttachedFile" && r.url)
      .map((r: any) => ({
        name: r.attributes?.name || "attachment",
        url: r.url,
      }));

    const refs = extractMediaUrls({}, attachments);
    const videoRefs = refs.filter((r) => r.name.endsWith(".mp4"));
    expect(videoRefs.length).toBeGreaterThan(0);
    expect(videoRefs[0].url).toContain("_apis/wit/attachments/");
  });

  it("downloads image attachment with correct auth", async () => {
    const result =
      await $`az boards work-item show --id ${DEFECT_ID} --org ${ORG} --output json 2>/dev/null`
        .text()
        .catch(() => "");

    if (!result) {
      console.log("Skipping: az boards not authenticated");
      return;
    }

    const item = JSON.parse(result);
    const refs = extractMediaUrls(item.fields || {});
    if (refs.length === 0) {
      console.log("Skipping: no inline images found");
      return;
    }

    // Download just the first image
    const tmpDir = mkdtempSync(join(tmpdir(), "media-integration-"));
    try {
      const downloads = await downloadMedia([refs[0]], tmpDir, $);

      expect(downloads).toHaveLength(1);
      expect(downloads[0].success).toBe(true);
      expect(downloads[0].fileSize).toBeGreaterThan(10_000); // > 10KB
      expect(downloads[0].fileType).toMatch(/^image\//);
      expect(existsSync(downloads[0].localPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("downloads video attachment with correct auth and validates size", async () => {
    const result =
      await $`az boards work-item show --id ${DEFECT_ID} --org ${ORG} --expand Relations --output json 2>/dev/null`
        .text()
        .catch(() => "");

    if (!result) {
      console.log("Skipping: az boards not authenticated");
      return;
    }

    const item = JSON.parse(result);
    const attachments = (item.relations || [])
      .filter((r: any) => r.rel === "AttachedFile" && r.url)
      .map((r: any) => ({
        name: r.attributes?.name || "attachment",
        url: r.url,
      }));

    const videoRefs = extractMediaUrls({}, attachments).filter((r) =>
      r.name.endsWith(".mp4"),
    );
    if (videoRefs.length === 0) {
      console.log("Skipping: no video attachments found");
      return;
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "media-integration-video-"));
    try {
      const downloads = await downloadMedia([videoRefs[0]], tmpDir, $);

      expect(downloads).toHaveLength(1);
      expect(downloads[0].success).toBe(true);
      expect(downloads[0].fileSize).toBeGreaterThan(1_000_000); // > 1MB
      expect(downloads[0].fileType).toMatch(/^video\//);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000); // Video may take a while
});

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Create a mock shell that records calls and returns configurable results.
 *
 * The mock captures the interpolated command string from tagged template
 * calls, making it easy to verify that `az rest` was called with the
 * correct flags (like `--resource`).
 */
function createMockShell(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
} = {}) {
  const calls: string[] = [];

  const shellResult = {
    exitCode: opts.exitCode ?? 0,
    stdout: { toString: () => opts.stdout ?? "" },
    stderr: { toString: () => opts.stderr ?? "" },
    text: async () => opts.stdout ?? "",
  };

  const shell: any = (strings: TemplateStringsArray, ...args: any[]) => {
    // Reconstruct the command string
    let cmd = "";
    for (let i = 0; i < strings.length; i++) {
      cmd += strings[i];
      if (i < args.length) cmd += String(args[i]);
    }
    calls.push(cmd);
    return {
      ...shellResult,
      nothrow: () => ({ quiet: () => shellResult }),
      quiet: () => shellResult,
      text: async () => opts.stdout ?? "",
    };
  };

  shell.calls = calls;
  return shell;
}
