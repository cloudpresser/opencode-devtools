import { describe, test, expect } from "bun:test";
import {
  parseLauncherMetadata,
  parseWorkerMetadata,
  resolveWorkerSession,
  WorkerSessionNotFoundError,
} from "./session-resolution";

// ─── Metadata Parsing ─────────────────────────────────────────────────────────

describe("parseLauncherMetadata", () => {
  test("extracts metadata from valid block", () => {
    const raw = `Some text before
<!-- workflow-metadata: {"type":"workflow-launch","workflowName":"implement","branchName":"feature/123","baseBranch":"staging","workerArgs":"123","worktreeDir":"/tmp/wt","workItemId":"123","agentName":"implement-worker","launchedAt":"2026-01-01T00:00:00.000Z"} -->
Some text after`;
    const meta = parseLauncherMetadata(raw);
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe("workflow-launch");
    expect(meta!.workflowName).toBe("implement");
    expect(meta!.branchName).toBe("feature/123");
    expect(meta!.worktreeDir).toBe("/tmp/wt");
    expect(meta!.agentName).toBe("implement-worker");
  });

  test("returns null when no metadata block", () => {
    expect(parseLauncherMetadata("just some text")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const raw = "<!-- workflow-metadata: {broken json} -->";
    expect(parseLauncherMetadata(raw)).toBeNull();
  });

  test("returns null for wrong type", () => {
    const raw =
      '<!-- workflow-metadata: {"type":"something-else","workflowName":"x"} -->';
    expect(parseLauncherMetadata(raw)).toBeNull();
  });
});

describe("parseWorkerMetadata", () => {
  test("extracts metadata from valid block", () => {
    const raw = `Template content
<!-- worker-metadata: {"type":"workflow-worker","workflowName":"implement","workerSessionId":"ses_abc123","workerArgs":"123","startedAt":"2026-01-01T00:00:00.000Z"} -->`;
    const meta = parseWorkerMetadata(raw);
    expect(meta).not.toBeNull();
    expect(meta!.type).toBe("workflow-worker");
    expect(meta!.workflowName).toBe("implement");
    expect(meta!.workerSessionId).toBe("ses_abc123");
  });

  test("returns null when no metadata block", () => {
    expect(parseWorkerMetadata("no metadata here")).toBeNull();
  });
});

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockShell(responses: Record<string, string>) {
  const $ = (strings: TemplateStringsArray, ...values: any[]) => {
    const cmd = strings.reduce(
      (acc, s, i) => acc + s + (values[i] ?? ""),
      "",
    );
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        return { text: async () => response };
      }
    }
    return { text: async () => "" };
  };
  return $;
}

function makeLauncherExport(opts: {
  workflowName: string;
  branchName: string;
  worktreeDir: string;
  launchedAt: string;
  agentName?: string;
}) {
  return JSON.stringify({
    messages: [
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "Worker launched" },
          {
            type: "text",
            text: `<!-- workflow-metadata: ${JSON.stringify({
              type: "workflow-launch",
              workflowName: opts.workflowName,
              branchName: opts.branchName,
              baseBranch: "staging",
              workerArgs: "123",
              worktreeDir: opts.worktreeDir,
              workItemId: "123",
              agentName: opts.agentName || "implement-worker",
              launchedAt: opts.launchedAt,
            })} -->`,
          },
        ],
      },
    ],
  });
}

function makeWorkerMessages(workflowName: string) {
  return [
    {
      info: { role: "user" },
      parts: [
        { type: "text", text: "Implement work item #123" },
        { type: "text", text: "Template content..." },
        {
          type: "text",
          text: `<!-- worker-metadata: ${JSON.stringify({
            type: "workflow-worker",
            workflowName,
            workerSessionId: "ses_worker1",
            workerArgs: "123",
            startedAt: "2026-01-01T00:01:00.000Z",
          })} -->`,
        },
      ],
    },
  ];
}

function createMockClient(
  sessions: Array<{
    id: string;
    directory: string;
    time: { created: number; updated: number };
  }>,
  messagesBySession: Record<string, any[]> = {},
) {
  return {
    session: {
      list: async (opts?: any) => {
        const dir = opts?.query?.directory;
        const filtered = dir
          ? sessions.filter((s) => s.directory === dir)
          : sessions;
        return { data: filtered };
      },
      messages: async (opts: any) => {
        const id = opts.path.id;
        return { data: messagesBySession[id] || [] };
      },
    },
  };
}

// ─── Session Resolution ───────────────────────────────────────────────────────

describe("resolveWorkerSession", () => {
  test("returns non-launcher for session without metadata", async () => {
    const $ = createMockShell({
      "opencode export ses_test1":
        '{"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"hello"}]}]}',
    });

    const result = await resolveWorkerSession("ses_test1", $);
    expect(result.isLauncher).toBe(false);
    expect(result.targetSessionId).toBe("ses_test1");
  });

  test("finds worker session by metadata match via SDK API", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/123",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    const client = createMockClient(
      [
        {
          id: "ses_launcher",
          directory: "/original",
          time: { created: 1767225600000, updated: 1767225600000 },
        },
        {
          id: "ses_worker1",
          directory: "/tmp/worktree",
          time: { created: 1767225660000, updated: 1767225660000 },
        },
        {
          id: "ses_unrelated",
          directory: "/tmp/worktree",
          time: { created: 1767225900000, updated: 1767225900000 },
        },
      ],
      {
        ses_worker1: makeWorkerMessages("implement"),
        ses_unrelated: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "unrelated session" }],
          },
        ],
      },
    );

    const result = await resolveWorkerSession(
      "ses_launcher",
      $,
      client,
    );
    expect(result.isLauncher).toBe(true);
    expect(result.launcherMetadata?.workflowName).toBe("implement");
    expect(result.workerSessionId).toBe("ses_worker1");
    expect(result.targetSessionId).toBe("ses_worker1");
  });

  test("throws WorkerSessionNotFoundError when no candidates match by metadata", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "fix-defect",
      branchName: "bug/456",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
      agentName: "defect-worker",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // Candidates exist but none have matching worker-metadata
    const client = createMockClient(
      [
        {
          id: "ses_wrong",
          directory: "/tmp/worktree",
          time: { created: 1767225720000, updated: 1767225720000 },
        },
      ],
      {
        ses_wrong: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "no metadata here" }],
          },
        ],
      },
    );

    expect(
      resolveWorkerSession("ses_launcher", $, client),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });

  test("throws WorkerSessionNotFoundError when no candidates at all", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/789",
      worktreeDir: "/tmp/gone",
      launchedAt: "2026-01-01T00:00:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // No sessions in the worktree directory
    const client = createMockClient([]);

    expect(
      resolveWorkerSession("ses_launcher", $, client),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });

  test("throws WorkerSessionNotFoundError when client is unavailable", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/123",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // No client passed
    expect(
      resolveWorkerSession("ses_launcher", $, undefined),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });

  test("filters out sessions created before launch time", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/123",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:10:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // Only old session exists (created well before launch)
    const client = createMockClient(
      [
        {
          id: "ses_old",
          directory: "/tmp/worktree",
          time: { created: 1767139200000, updated: 1767139200000 },
        },
      ],
      {
        ses_old: makeWorkerMessages("implement"),
      },
    );

    // Even though metadata matches, it's too old
    expect(
      resolveWorkerSession("ses_launcher", $, client),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });

  test("excludes the launcher session ID from candidates", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/123",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // Only the launcher itself is in the list (with matching metadata somehow)
    const client = createMockClient(
      [
        {
          id: "ses_launcher",
          directory: "/tmp/worktree",
          time: { created: 1767225600000, updated: 1767225600000 },
        },
      ],
      {
        ses_launcher: makeWorkerMessages("implement"),
      },
    );

    expect(
      resolveWorkerSession("ses_launcher", $, client),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });

  test("handles export failure gracefully (not a launcher)", async () => {
    const $ = (_strings: TemplateStringsArray, ..._values: any[]) => ({
      text: async () => {
        throw new Error("export failed");
      },
    });

    const result = await resolveWorkerSession("ses_bad", $ as any);
    expect(result.isLauncher).toBe(false);
    expect(result.targetSessionId).toBe("ses_bad");
  });

  test("matches correct workflow when multiple workers exist", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "fix-defect",
      branchName: "bug/456",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
      agentName: "defect-worker",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    // Two workers — one for implement, one for fix-defect
    const client = createMockClient(
      [
        {
          id: "ses_wrong_workflow",
          directory: "/tmp/worktree",
          time: { created: 1767225660000, updated: 1767225660000 },
        },
        {
          id: "ses_correct",
          directory: "/tmp/worktree",
          time: { created: 1767225720000, updated: 1767225720000 },
        },
      ],
      {
        ses_wrong_workflow: makeWorkerMessages("implement"),
        ses_correct: makeWorkerMessages("fix-defect"),
      },
    );

    const result = await resolveWorkerSession(
      "ses_launcher",
      $,
      client,
    );
    expect(result.isLauncher).toBe(true);
    expect(result.workerSessionId).toBe("ses_correct");
    expect(result.targetSessionId).toBe("ses_correct");
  });

  test("handles client.session.list failure (throws)", async () => {
    const launcherExport = makeLauncherExport({
      workflowName: "implement",
      branchName: "feature/123",
      worktreeDir: "/tmp/worktree",
      launchedAt: "2026-01-01T00:00:00.000Z",
    });

    const $ = createMockShell({
      "opencode export ses_launcher": launcherExport,
    });

    const client = {
      session: {
        list: async () => {
          throw new Error("API error");
        },
        messages: async () => ({ data: [] }),
      },
    };

    expect(
      resolveWorkerSession("ses_launcher", $, client),
    ).rejects.toThrow(WorkerSessionNotFoundError);
  });
});
