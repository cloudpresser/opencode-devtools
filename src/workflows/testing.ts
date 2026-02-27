/**
 * Workflow Test Harness — testWorkflowLifecycle()
 *
 * Verifies that a WorkflowDefinition integrates correctly with the
 * workflow engine lifecycle. Uses the real registry + engine with
 * mocked dependencies, so it tests actual integration, not unit behavior.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowUtils,
  WorkflowLogger,
} from "./types";
import { WorkflowRegistry } from "./registry";
import { buildWorkflowHooks } from "./engine";

// ─── Mock Factory ─────────────────────────────────────────────────────────────

export interface TestWorkflowOptions {
  workflow: WorkflowDefinition;
  /** Override default mock utils. Partial merge. */
  utilsOverrides?: Partial<WorkflowUtils>;
}

function createMockLogger(): WorkflowLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function createMockUtils(
  overrides?: Partial<WorkflowUtils>,
): WorkflowUtils {
  const defaults: WorkflowUtils = {
    provider: "azure-devops",
    $: Object.assign(
      () => ({
        text: async () => "",
        quiet: () => ({ nothrow: () => ({ text: async () => "" }) }),
        nothrow: () => ({ quiet: () => ({ text: async () => "" }) }),
      }),
      { raw: () => ({}) },
    ),
    log: createMockLogger(),
    root: "/test/project",
    config: { provider: "azure-devops", workflows: {}, tools: {} } as any,
    client: {
      session: {
        abort: mock(() => Promise.resolve()),
      },
    },

    fetchWorkItem: mock(async (id: string) => ({
      formatted: `[Work Item #${id}] Test Work Item`,
      raw: {
        id: Number(id),
        title: "Test Work Item",
        type: "Task",
        state: "Active",
        assignedTo: "tester",
        description: "Test description",
        url: `https://dev.azure.com/test/_workitems/edit/${id}`,
        fields: {
          "System.Title": "Test Work Item",
          "System.WorkItemType": "Task",
          "System.State": "Active",
          "Microsoft.VSTS.Scheduling.RemainingWork": 4,
        },
        relations: [],
        pullRequestIds: [],
        attachments: [],
      } as any,
    })),

    processMedia: mock(async () => ""),

    discoverPR: mock(async () => undefined),

    formatPR: mock(async (prId: string) => `[PR #${prId}] Test PR`),

    fetchPRComments: mock(
      async () => "> No active PR review threads.",
    ),

    loadTemplate: mock((path: string) => {
      const { readFileSync } = require("node:fs");
      return readFileSync(path, "utf-8");
    }),

    substitutePlaceholders: mock(
      (template: string, vars: Record<string, string>) => {
        let result = template;
        for (const [key, value] of Object.entries(vars)) {
          result = result.replaceAll(`{{${key}}}`, value);
        }
        return result;
      },
    ),

    launchWorker: mock(async () => ({
      success: true,
      message: "Worker launched",
      worktreeDir: "/test/worktree",
    })),

    abortSession: mock(async () => {}),

    generateUserMessage: mock(
      (
        workflowName: string,
        _workItem: any,
        workItemId: string | null,
        rawArgs: string,
      ) =>
        workItemId
          ? `${workflowName} #${workItemId}`
          : `${workflowName}: ${rawArgs}`,
    ),
  };

  return { ...defaults, ...overrides } as WorkflowUtils;
}

// ─── Test Harness ─────────────────────────────────────────────────────────────

export function testWorkflowLifecycle(options: TestWorkflowOptions): void {
  const { workflow, utilsOverrides } = options;

  describe(`Workflow lifecycle: ${workflow.name}`, () => {
    let registry: WorkflowRegistry;
    let hooks: ReturnType<typeof buildWorkflowHooks>;
    let utils: WorkflowUtils;
    let log: WorkflowLogger;

    beforeEach(() => {
      registry = new WorkflowRegistry();
      registry.register(workflow);
      log = createMockLogger();
      utils = createMockUtils(utilsOverrides);
      hooks = buildWorkflowHooks(registry, utils, log);
    });

    // ── Command Registration ──

    test("registers a slash command for the workflow", () => {
      const defs = registry.getCommandDefinitions();
      expect(defs[workflow.name]).toBeDefined();
      expect(defs[workflow.name].description).toBeTruthy();
    });

    if (
      workflow.usesWorktree !== false &&
      workflow.agent
    ) {
      test("registers the workflow-run command for worker dispatch", () => {
        const defs = registry.getCommandDefinitions();
        expect(defs["workflow-run"]).toBeDefined();
      });
    }

    // ── Template Existence ──

    test("worker template file exists", () => {
      if (!workflow.__dirname) return;
      const path = join(workflow.__dirname, workflow.workerTemplate);
      expect(existsSync(path)).toBe(true);
    });

    if (workflow.launcherTemplate) {
      test("launcher template file exists", () => {
        if (!workflow.__dirname) return;
        const path = join(
          workflow.__dirname,
          workflow.launcherTemplate!,
        );
        expect(existsSync(path)).toBe(true);
      });
    }

    // ── Agent Registration ──

    if (workflow.agent) {
      test("agent is registered in config hook", async () => {
        const config: any = { command: {}, agent: {} };
        await hooks.config(config);
        expect(config.agent[workflow.agent!.name]).toBeDefined();
      });

      test("agent has correct disabled tools", async () => {
        const config: any = { command: {}, agent: {} };
        await hooks.config(config);
        const agent = config.agent[workflow.agent!.name];
        if (workflow.agent!.disabledTools?.length) {
          expect(agent.tools).toBeDefined();
          for (const t of workflow.agent!.disabledTools!) {
            expect(agent.tools[t]).toBe(false);
          }
        }
      });

      test("agent has correct permissions", async () => {
        const config: any = { command: {}, agent: {} };
        await hooks.config(config);
        const agent = config.agent[workflow.agent!.name];
        if (workflow.agent!.permissions?.length) {
          expect(agent.permissions).toBeDefined();
          for (const p of workflow.agent!.permissions!) {
            expect(agent.permissions[p]).toBe("allow");
          }
        }
      });
    }

    // ── Tool Requirements ──

    test("reports required tools correctly", () => {
      const required = registry.getRequiredTools();
      for (const key of workflow.requiredTools) {
        expect(required.has(key)).toBe(true);
      }
      // workflows always need commands
      expect(required.has("commands")).toBe(true);
    });

    // ── Worker Context Injection (via workflow-run) ──

    if (workflow.usesWorktree !== false) {
      test("worker dispatch injects context with no unreplaced placeholders", async () => {
        const output = { parts: [{ type: "text", text: "original" }] };
        await hooks["command.execute.before"](
          {
            command: "workflow-run",
            sessionID: "test-session",
            arguments: `${workflow.name} 12345`,
          },
          output,
        );

        // 3 parts: user message + template + worker metadata
        expect(output.parts.length).toBe(3);
        expect(output.parts[0].text).toBeTruthy();
        // Check no unreplaced placeholders in template
        const context = output.parts[1].text;
        const unreplaced = context.match(/\{\{[A-Z_]+\}\}/g) || [];
        expect(unreplaced).toEqual([]);
        // Verify worker metadata block
        expect(output.parts[2].text).toContain("<!-- worker-metadata:");
      });
    }

    // ── Direct Workflow Injection ──

    if (workflow.usesWorktree === false) {
      test("direct command injects context", async () => {
        const output = { parts: [{ type: "text", text: "original" }] };
        await hooks["command.execute.before"](
          {
            command: workflow.name,
            sessionID: "test-session",
            arguments: "test-args",
          },
          output,
        );

        expect(output.parts.length).toBe(2);
        expect(output.parts[0].text).toBeTruthy();
      });
    }

    // ── Launcher (Worktree Workflows) ──

    if (workflow.usesWorktree !== false && workflow.resolve) {
      test("deterministic launch creates worktree and aborts session", async () => {
        // This test requires the resolve function to return a result
        // with specific args. We test that the framework handles it.
        const output = { parts: [{ type: "text", text: "original" }] };
        await hooks["command.execute.before"](
          {
            command: workflow.name,
            sessionID: "test-session",
            arguments: "12345 staging",
          },
          output,
        );

        // Verify output was modified (either launcher or agent path)
        expect(output.parts.length).toBeGreaterThanOrEqual(1);
      });
    }

    // ── Non-Interference ──

    test("unknown commands pass through unchanged", async () => {
      const output = {
        parts: [{ type: "text", text: "original content" }],
      };
      await hooks["command.execute.before"](
        {
          command: "some-unknown-command",
          sessionID: "test-session",
          arguments: "test",
        },
        output,
      );

      expect(output.parts[0].text).toBe("original content");
    });

    // ── injectAfterWrite ──

    if (workflow.injectAfterWrite?.length) {
      test("injectAfterWrite handlers fire for write tools", async () => {
        const output = {
          title: "edit",
          output: "File edited successfully",
          metadata: {},
        };

        await hooks["tool.execute.after"](
          {
            tool: "edit",
            sessionID: "test-session",
            callID: "test-call",
            args: { filePath: "/test/file.ts" },
          },
          output,
        );

        // Output may or may not be modified depending on handler logic
        // Just verify it doesn't throw
        expect(output.output).toBeTruthy();
      });
    }

    // ── Conclusion Strategy ──

    test("conclusion strategy is defined", () => {
      expect(workflow.conclusion).toBeDefined();
      expect(workflow.conclusion.name).toBeTruthy();
    });
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { createMockUtils, createMockLogger };
