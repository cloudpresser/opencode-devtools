import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { createWorkflowDef } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: createWorkflowDef,
});

// ─── Custom Tests ─────────────────────────────────────────────────────────────

describe("create-workflow", () => {
  let registry: WorkflowRegistry;
  let utils: ReturnType<typeof createMockUtils>;
  let hooks: ReturnType<typeof buildWorkflowHooks>;

  beforeEach(() => {
    registry = new WorkflowRegistry();
    registry.register(createWorkflowDef);
    utils = createMockUtils();
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());
  });

  test("is a direct workflow (no worktree)", () => {
    expect(createWorkflowDef.usesWorktree).toBe(false);
  });

  test("uses noneConclusion", () => {
    expect(createWorkflowDef.conclusion.name).toBe("none");
  });

  test("has no required tools (uses existing tools in session)", () => {
    expect(createWorkflowDef.requiredTools).toEqual([]);
  });

  test("injects context with no args", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "create-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    expect(output.parts[0].text).toContain("Create a new workflow");
    // Should have framework reference injected
    const context = output.parts[1].text;
    expect(context).toContain("WorkflowDefinition");
    expect(context).toContain("ConclusionStrategy");
  });

  test("injects command file content when .md path provided", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    // Use the create-workflow's own template as a test file
    const testFile = `${import.meta.dir}/create-workflow.md`;
    await hooks["command.execute.before"](
      {
        command: "create-workflow",
        sessionID: "test-session",
        arguments: testFile,
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    const context = output.parts[1].text;
    // Should contain the file contents (our own template)
    expect(context).toContain("Analyze & Propose");
  });

  test("template has no unreplaced structural placeholders", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "create-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    const context = output.parts[1].text;
    // These specific placeholders should all be replaced
    expect(context).not.toContain("{{SESSION_ANALYSIS}}");
    expect(context).not.toContain("{{COMMAND_FILE}}");
    expect(context).not.toContain("{{PLUGIN_WORKFLOWS_DIR}}");
    expect(context).not.toContain("{{PLUGIN_INDEX_PATH}}");
  });
});
