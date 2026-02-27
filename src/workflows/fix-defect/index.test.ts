import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { defectWorkflow } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";
import * as branchRegistry from "../../branch-registry";

// Mock the branch registry module
const mockGetEntry = mock(() => undefined as branchRegistry.BranchEntry | undefined);
const mockSetEntry = mock(() => {});
mock.module("../../branch-registry", () => ({
  getEntry: mockGetEntry,
  setEntry: mockSetEntry,
  removeEntry: mock(() => {}),
  getAllEntries: mock(() => ({})),
}));

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: defectWorkflow,
});

// ─── Unit Tests: workflow config ──────────────────────────────────────────────

describe("defect workflow config", () => {
  test("includes generate in requiredTools", () => {
    expect(defectWorkflow.requiredTools).toContain("generate");
  });

  test("has injectAfterWrite handler", () => {
    expect(defectWorkflow.injectAfterWrite).toBeDefined();
    expect(defectWorkflow.injectAfterWrite!.length).toBe(1);
  });

  test("does not include get-pr or pr-comments in requiredTools", () => {
    expect(defectWorkflow.requiredTools).not.toContain("get-pr");
    expect(defectWorkflow.requiredTools).not.toContain("pr-comments");
  });
});

// ─── Unit Tests: resolve ──────────────────────────────────────────────────────

describe("defect workflow resolve", () => {
  beforeEach(() => {
    mockGetEntry.mockReset();
    mockSetEntry.mockReset();
  });

  test("returns undefined when no workItemId", async () => {
    const utils = createMockUtils();
    const result = await defectWorkflow.resolve!({
      args: "",
      workItemId: null,
      utils,
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when no parent in registry and no explicit baseBranch", async () => {
    mockGetEntry.mockReturnValue(undefined);
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 71405,
          title: "Dark mode flicker",
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
    const result = await defectWorkflow.resolve!({
      args: "71405",
      workItemId: "71405",
      utils,
    });
    expect(result).toBeUndefined();
  });

  test("derives dev/ branch when parent found in registry", async () => {
    mockGetEntry.mockReturnValue({
      branch: "feature/70000-add-dark-mode",
      targetBranch: "staging",
      workflow: "plan",
      createdAt: new Date().toISOString(),
    });
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 71405,
          title: "Dark mode flicker bug",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {},
          relations: [
            { id: 70000, type: "User Story", title: "Add dark mode", state: "Active", relation: "Parent" },
          ],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    const result = await defectWorkflow.resolve!({
      args: "71405",
      workItemId: "71405",
      utils,
    });

    expect(result).toBeDefined();
    expect(result!.branchName).toBe("dev/71405-dark-mode-flicker-bug");
    expect(result!.baseBranch).toBe("feature/70000-add-dark-mode");
    expect(result!.reuseExisting).toBe(false);
    expect(result!.workerArgs).toBe("71405");
  });

  test("uses explicit baseBranch from args over registry", async () => {
    mockGetEntry.mockReturnValue({
      branch: "feature/70000-add-dark-mode",
      targetBranch: "staging",
      workflow: "plan",
      createdAt: new Date().toISOString(),
    });
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 71405,
          title: "Dark mode flicker",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {},
          relations: [
            { id: 70000, type: "User Story", title: "Add dark mode", state: "Active", relation: "Parent" },
          ],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    const result = await defectWorkflow.resolve!({
      args: "71405 main",
      workItemId: "71405",
      utils,
    });

    expect(result!.baseBranch).toBe("main");
  });

  test("registers branch in registry", async () => {
    mockGetEntry.mockReturnValue({
      branch: "feature/70000-add-dark-mode",
      targetBranch: "staging",
      workflow: "plan",
      createdAt: new Date().toISOString(),
    });
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 71405,
          title: "Dark mode flicker",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {},
          relations: [
            { id: 70000, type: "User Story", title: "Add dark mode", state: "Active", relation: "Parent" },
          ],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    await defectWorkflow.resolve!({
      args: "71405",
      workItemId: "71405",
      utils,
    });

    expect(mockSetEntry).toHaveBeenCalledWith("71405", expect.objectContaining({
      branch: "dev/71405-dark-mode-flicker",
      targetBranch: "feature/70000-add-dark-mode",
      workflow: "fix-defect",
    }));
  });

  test("has side effects for work item state update", async () => {
    mockGetEntry.mockReturnValue({
      branch: "feature/70000-add-dark-mode",
      targetBranch: "staging",
      workflow: "plan",
      createdAt: new Date().toISOString(),
    });
    const mockShell = Object.assign(
      (..._args: any[]) => ({
        quiet: () => ({ nothrow: () => Promise.resolve() }),
        nothrow: () => ({ quiet: () => Promise.resolve() }),
      }),
    );
    const utils = createMockUtils({
      $: mockShell,
      fetchWorkItem: mock(async () => ({
        formatted: "test",
        raw: {
          id: 71405,
          title: "Dark mode flicker",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {},
          relations: [
            { id: 70000, type: "User Story", title: "Add dark mode", state: "Active", relation: "Parent" },
          ],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    const result = await defectWorkflow.resolve!({
      args: "71405",
      workItemId: "71405",
      utils,
    });

    expect(result!.sideEffects).toBeDefined();
    await result!.sideEffects!();
  });

  test("returns undefined when fetchWorkItem fails", async () => {
    const utils = createMockUtils({
      fetchWorkItem: mock(async () => {
        throw new Error("Network error");
      }),
    });
    const result = await defectWorkflow.resolve!({
      args: "71405",
      workItemId: "71405",
      utils,
    });
    expect(result).toBeUndefined();
  });
});

// ─── Unit Tests: injectWorkerContext ──────────────────────────────────────────

describe("defect workflow injectWorkerContext", () => {
  test("injects all template variables", async () => {
    const utils = createMockUtils();

    const result = await defectWorkflow.injectWorkerContext({
      args: "71405",
      workItemId: "71405",
      template: "test template",
      sessionID: "test-session",
      utils,
    });

    expect(result.templateVars.DEFECT_CONTEXT).toBeTruthy();
    expect(result.templateVars.TARGET_BRANCH).toBeTruthy();
    expect(result.templateVars.DEFECT_ID).toBe("71405");
    expect(result.templateVars.TESTING_GUIDANCE).toBeTruthy();
    expect(result.templateVars.TESTING_GUIDANCE).toContain("add-tests");
  });

  test("handles no work item ID", async () => {
    const utils = createMockUtils();
    const result = await defectWorkflow.injectWorkerContext({
      args: "",
      workItemId: null,
      template: "test",
      sessionID: "test-session",
      utils,
    });

    expect(result.templateVars.DEFECT_CONTEXT).toContain("No defect ID");
    expect(result.templateVars.REMAINING_WORK).toBe("unknown");
    expect(result.templateVars.TARGET_BRANCH).toBe("staging");
  });
});

// ─── E2E: Full Lifecycle ─────────────────────────────────────────────────────

describe("defect workflow e2e lifecycle", () => {
  let registry: WorkflowRegistry;
  let utils: ReturnType<typeof createMockUtils>;
  let hooks: ReturnType<typeof buildWorkflowHooks>;

  beforeEach(() => {
    mockGetEntry.mockReset();
    mockSetEntry.mockReset();
    // Set up registry to return a parent branch for deterministic launch
    mockGetEntry.mockReturnValue({
      branch: "feature/70000-add-dark-mode",
      targetBranch: "staging",
      workflow: "plan",
      createdAt: new Date().toISOString(),
    });

    registry = new WorkflowRegistry();
    registry.register(defectWorkflow);
    utils = createMockUtils({
      fetchWorkItem: mock(async (id: string) => ({
        formatted: `[Defect #${id}] Test Defect`,
        raw: {
          id: Number(id),
          title: "Test Defect",
          type: "Bug",
          state: "Active",
          assignedTo: "tester",
          description: "",
          url: "",
          fields: {
            "Microsoft.VSTS.Scheduling.RemainingWork": 4,
          },
          relations: [
            { id: 70000, type: "User Story", title: "Add dark mode", state: "Active", relation: "Parent" },
          ],
          pullRequestIds: [],
          attachments: [],
        } as any,
      })),
    });
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());
  });

  test("deterministic launch with registry lookup", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "fix-defect",
        sessionID: "launcher-session",
        arguments: "71405",
      },
      output,
    );

    expect(utils.launchWorker).toHaveBeenCalled();
    const launchArgs = (utils.launchWorker as any).mock.calls[0][0];
    expect(launchArgs.branchName).toMatch(/^dev\/71405-/);
    expect(launchArgs.reuseExisting).toBe(false);
    expect(utils.abortSession).toHaveBeenCalledWith("launcher-session");
  });

  test("agent fallback when no parent in registry", async () => {
    mockGetEntry.mockReturnValue(undefined);
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());

    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "fix-defect",
        sessionID: "launcher-session",
        arguments: "71405",
      },
      output,
    );

    expect(utils.launchWorker).not.toHaveBeenCalled();
    expect(utils.abortSession).not.toHaveBeenCalled();
    expect(output.parts.length).toBe(2);
  });

  test("worker dispatch with full context", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "workflow-run",
        sessionID: "worker-session",
        arguments: "fix-defect 71405",
      },
      output,
    );

    // 3 parts: user message + template + worker metadata
    expect(output.parts.length).toBe(3);
    const context = output.parts[1].text;
    const unreplaced = context.match(/\{\{[A-Z_]+\}\}/g) || [];
    expect(unreplaced).toEqual([]);
    expect(output.parts[2].text).toContain("<!-- worker-metadata:");
    expect(output.parts[2].text).toContain('"workflowName":"fix-defect"');
  });
});
