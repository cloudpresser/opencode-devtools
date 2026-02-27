import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { implementWorkflow, deriveBranchName } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";

// Mock the branch registry module
const mockSetEntry = mock(() => {});
mock.module("../../branch-registry", () => ({
  getEntry: mock(() => undefined),
  setEntry: mockSetEntry,
  removeEntry: mock(() => {}),
  getAllEntries: mock(() => ({})),
}));

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: implementWorkflow,
});

// ─── Unit Tests: workflow config ──────────────────────────────────────────────

describe("implement workflow config", () => {
  test("includes generate in requiredTools", () => {
    expect(implementWorkflow.requiredTools).toContain("generate");
  });

  test("has injectAfterWrite handler", () => {
    expect(implementWorkflow.injectAfterWrite).toBeDefined();
    expect(implementWorkflow.injectAfterWrite!.length).toBe(1);
  });
});

// ─── Unit Tests: deriveBranchName ─────────────────────────────────────────────

describe("deriveBranchName", () => {
  test("bug type → dev/ prefix", () => {
    const result = deriveBranchName({
      id: 12345,
      type: "Bug",
      title: "Purchase flow breaks on checkout",
    });
    expect(result).toBe("dev/12345-purchase-flow-breaks-on-checkout");
  });

  test("task type → dev/ prefix", () => {
    const result = deriveBranchName({
      id: 67890,
      type: "Task",
      title: "Add Dark Mode Toggle",
    });
    expect(result).toBe("dev/67890-add-dark-mode-toggle");
  });

  test("handles special characters", () => {
    const result = deriveBranchName({
      id: 111,
      type: "Task",
      title: "Fix: API endpoint (v2) [urgent]",
    });
    expect(result).toBe("dev/111-fix-api-endpoint-v2-urgent");
  });

  test("truncates long titles to 50 chars", () => {
    const result = deriveBranchName({
      id: 222,
      type: "Task",
      title: "This is a very long title that should be truncated to fifty characters maximum",
    });
    const slug = result.split("/")[1].split("-").slice(1).join("-");
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});

// ─── Unit Tests: resolve ──────────────────────────────────────────────────────

describe("implement workflow resolve", () => {
  beforeEach(() => {
    mockSetEntry.mockReset();
  });

  test("returns undefined when only workItemId provided (no baseBranch)", async () => {
    const utils = createMockUtils();
    const result = await implementWorkflow.resolve!({
      args: "12345",
      workItemId: "12345",
      utils,
    });
    expect(result).toBeUndefined();
  });

  test("returns ResolveResult when both workItemId and baseBranch provided", async () => {
    const utils = createMockUtils();
    const result = await implementWorkflow.resolve!({
      args: "12345 staging",
      workItemId: "12345",
      utils,
    });
    expect(result).toBeDefined();
    expect(result!.baseBranch).toBe("staging");
    expect(result!.workerArgs).toBe("12345");
    expect(result!.reuseExisting).toBe(false);
  });

  test("derives dev/ branch name from work item", async () => {
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 12345,
          title: "Fix checkout bug",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {},
          relations: [],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    const result = await implementWorkflow.resolve!({
      args: "12345 staging",
      workItemId: "12345",
      utils,
    });
    expect(result!.branchName).toBe("dev/12345-fix-checkout-bug");
  });

  test("falls back to dev/<id> when fetch fails", async () => {
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => {
        throw new Error("Network error");
      }),
    });
    const result = await implementWorkflow.resolve!({
      args: "12345 staging",
      workItemId: "12345",
      utils,
    });
    expect(result!.branchName).toBe("dev/12345");
  });

  test("registers branch in registry", async () => {
    const utils = createMockUtils();
    await implementWorkflow.resolve!({
      args: "12345 feature/70000-add-dark-mode",
      workItemId: "12345",
      utils,
    });

    expect(mockSetEntry).toHaveBeenCalledWith("12345", expect.objectContaining({
      targetBranch: "feature/70000-add-dark-mode",
      workflow: "implement",
    }));
  });
});

// ─── Unit Tests: injectWorkerContext ──────────────────────────────────────────

describe("implement workflow injectWorkerContext", () => {
  test("injects work item context, media, and new template vars", async () => {
    const utils = createMockUtils();
    const result = await implementWorkflow.injectWorkerContext({
      args: "12345 feature/70000-add-dark-mode",
      workItemId: "12345",
      template: "{{WORK_ITEM_CONTEXT}} {{MEDIA_CONTEXT}} {{REMAINING_WORK}} {{TARGET_BRANCH}} {{TESTING_GUIDANCE}}",
      sessionID: "test-session",
      utils,
    });

    expect(result.templateVars.WORK_ITEM_CONTEXT).toContain("12345");
    expect(result.templateVars.REMAINING_WORK).toBe("32");
    expect(result.templateVars.TARGET_BRANCH).toBe("feature/70000-add-dark-mode");
    expect(result.templateVars.TESTING_GUIDANCE).toBeTruthy();
    expect(result.templateVars.TESTING_GUIDANCE).toContain("add-tests");
  });

  test("handles missing work item ID gracefully", async () => {
    const utils = createMockUtils();
    const result = await implementWorkflow.injectWorkerContext({
      args: "",
      workItemId: null,
      template: "{{WORK_ITEM_CONTEXT}}",
      sessionID: "test-session",
      utils,
    });

    expect(result.templateVars.WORK_ITEM_CONTEXT).toContain("No work item ID");
    expect(result.templateVars.REMAINING_WORK).toBe("unknown");
    expect(result.templateVars.TARGET_BRANCH).toBe("staging");
    expect(result.templateVars.TESTING_GUIDANCE).toBeTruthy();
  });
});

// ─── E2E: Full Launcher → Worker Lifecycle ───────────────────────────────────

describe("implement workflow e2e lifecycle", () => {
  let registry: WorkflowRegistry;
  let utils: ReturnType<typeof createMockUtils>;
  let hooks: ReturnType<typeof buildWorkflowHooks>;

  beforeEach(() => {
    mockSetEntry.mockReset();
    registry = new WorkflowRegistry();
    registry.register(implementWorkflow);
    utils = createMockUtils();
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());
  });

  test("deterministic launch: creates worktree and aborts", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "implement",
        sessionID: "launcher-session",
        arguments: "12345 staging",
      },
      output,
    );

    expect(utils.launchWorker).toHaveBeenCalled();
    expect(utils.abortSession).toHaveBeenCalledWith("launcher-session");
    expect(output.parts.length).toBe(3);
    expect(output.parts[0].text).toContain("Worker launched");
    expect(output.parts[1].text).toContain("Do NOT continue working");
    const meta = output.parts[2].text;
    expect(meta).toContain("<!-- workflow-metadata:");
    expect(meta).toContain('"workflowName":"implement"');
    expect(meta).toContain("-->");
  });

  test("agent fallback when no baseBranch", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "implement",
        sessionID: "launcher-session",
        arguments: "12345",
      },
      output,
    );

    expect(utils.launchWorker).not.toHaveBeenCalled();
    expect(utils.abortSession).not.toHaveBeenCalled();
    expect(output.parts.length).toBe(2);
  });

  test("worker dispatch injects full context", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "workflow-run",
        sessionID: "worker-session",
        arguments: "implement 12345",
      },
      output,
    );

    expect(output.parts.length).toBe(3);
    const context = output.parts[1].text;
    const unreplaced = context.match(/\{\{[A-Z_]+\}\}/g) || [];
    expect(unreplaced).toEqual([]);
    const workerMeta = output.parts[2].text;
    expect(workerMeta).toContain("<!-- worker-metadata:");
    expect(workerMeta).toContain('"workerSessionId":"worker-session"');
  });

  test("worker dispatch handles quoted arguments from OpenCode CLI", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "workflow-run",
        sessionID: "worker-session",
        arguments: '"implement 12345"',
      },
      output,
    );

    expect(output.parts.length).toBe(3);
    expect(output.parts[0].text).toBeTruthy();
    const context = output.parts[1].text;
    const unreplaced = context.match(/\{\{[A-Z_]+\}\}/g) || [];
    expect(unreplaced).toEqual([]);
    const workerMeta = output.parts[2].text;
    expect(workerMeta).toContain("<!-- worker-metadata:");
  });

  test("worker template includes conclusion strategy content", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "workflow-run",
        sessionID: "worker-session",
        arguments: "implement 12345",
      },
      output,
    );

    const context = output.parts[1].text;
    expect(context).toContain("push-queue-schedule");
    expect(context).toContain("commit");
  });
});
