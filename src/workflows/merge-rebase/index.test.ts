import { describe, test, expect, beforeEach } from "bun:test";
import {
  testWorkflowLifecycle,
  createMockUtils,
  createMockLogger,
} from "../testing";
import { mergeRebaseWorkflow } from "./index";
import { WorkflowRegistry } from "../registry";
import { buildWorkflowHooks } from "../engine";

// ─── Lifecycle Harness Tests ──────────────────────────────────────────────────

testWorkflowLifecycle({
  workflow: mergeRebaseWorkflow,
});

// ─── Custom Tests ─────────────────────────────────────────────────────────────

describe("merge-rebase workflow", () => {
  test("injects branch name into template", async () => {
    const registry = new WorkflowRegistry();
    registry.register(mergeRebaseWorkflow);
    const utils = createMockUtils();
    const hooks = buildWorkflowHooks(registry, utils, createMockLogger());

    const output = { parts: [{ type: "text", text: "original" }] };
    await hooks["command.execute.before"](
      {
        command: "merge-rebase",
        sessionID: "test-session",
        arguments: "feature/my-branch",
      },
      output,
    );

    expect(output.parts.length).toBe(2);
    expect(output.parts[0].text).toContain("feature/my-branch");
    // Template should have branch substituted
    const context = output.parts[1].text;
    expect(context).toContain("feature/my-branch");
    expect(context).not.toContain("{{BRANCH}}");
  });

  test("conclusion strategy is direct-push", () => {
    expect(mergeRebaseWorkflow.conclusion.name).toBe("direct-push");
  });

  test("has injectAfterWrite handler for merge markers", () => {
    expect(mergeRebaseWorkflow.injectAfterWrite).toBeDefined();
    expect(mergeRebaseWorkflow.injectAfterWrite!.length).toBe(1);
  });
});
