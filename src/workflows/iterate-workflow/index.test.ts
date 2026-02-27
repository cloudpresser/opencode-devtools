import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { iterateWorkflowDef } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: iterateWorkflowDef,
});

// ─── Custom Tests ─────────────────────────────────────────────────────────────

describe("iterate-workflow", () => {
  let registry: WorkflowRegistry;
  let utils: ReturnType<typeof createMockUtils>;
  let hooks: ReturnType<typeof buildWorkflowHooks>;

  beforeEach(() => {
    registry = new WorkflowRegistry();
    registry.register(iterateWorkflowDef);
    utils = createMockUtils();
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());
  });

  test("is a direct workflow (no worktree)", () => {
    expect(iterateWorkflowDef.usesWorktree).toBe(false);
  });

  test("uses noneConclusion", () => {
    expect(iterateWorkflowDef.conclusion.name).toBe("none");
  });

  test("handles missing session ID gracefully", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "iterate-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    expect(output.parts[0].text).toContain("session ID");
    const context = output.parts[1].text;
    expect(context).toContain("No valid session ID");
  });

  test("handles non-ses_ argument gracefully", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "iterate-workflow",
        sessionID: "test-session",
        arguments: "not-a-session-id",
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    const context = output.parts[1].text;
    expect(context).toContain("No valid session ID");
  });

  test("template has no unreplaced structural placeholders for no-session path", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "iterate-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    const context = output.parts[1].text;
    expect(context).not.toContain("{{SESSION_ID}}");
    expect(context).not.toContain("{{SESSION_ANALYSIS}}");
    expect(context).not.toContain("{{WORKFLOW_NAME}}");
    expect(context).not.toContain("{{PLUGIN_WORKFLOWS_DIR}}");
  });
});
