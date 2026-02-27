import { describe, test, expect, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { debugWorkflowDef } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: debugWorkflowDef,
});

// ─── Custom Tests ─────────────────────────────────────────────────────────────

describe("debug-workflow", () => {
  let registry: WorkflowRegistry;
  let utils: ReturnType<typeof createMockUtils>;
  let hooks: ReturnType<typeof buildWorkflowHooks>;

  beforeEach(() => {
    registry = new WorkflowRegistry();
    registry.register(debugWorkflowDef);
    utils = createMockUtils();
    hooks = buildWorkflowHooks(registry, utils, createMockLogger());
  });

  test("is a direct workflow (no worktree)", () => {
    expect(debugWorkflowDef.usesWorktree).toBe(false);
  });

  test("uses noneConclusion", () => {
    expect(debugWorkflowDef.conclusion.name).toBe("none");
  });

  test("injects diagnostics with no args", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "debug-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    expect(output.parts[0].text).toContain("Debug workflow");
    const context = output.parts[1].text;
    // Should have registered workflows section populated
    expect(context).toContain("Registered Workflows");
    // Should have the diagnostic methodology
    expect(context).toContain("Diagnostic Methodology");
    // Should not have unreplaced structural placeholders
    expect(context).not.toContain("{{TARGET_AREA}}");
    expect(context).not.toContain("{{PLUGIN_SRC_DIR}}");
    expect(context).not.toContain("{{REGISTERED_WORKFLOWS}}");
  });

  test("sets target area from args", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "debug-workflow",
        sessionID: "test-session",
        arguments: "dispatch",
      },
      output,
    );

    expect(output.parts[0].text).toContain("dispatch");
  });

  test("includes framework file paths", async () => {
    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "debug-workflow",
        sessionID: "test-session",
        arguments: "",
      },
      output,
    );

    const context = output.parts[1].text;
    expect(context).toContain("engine.ts");
    expect(context).toContain("registry.ts");
    expect(context).toContain("session-resolution.ts");
  });
});
