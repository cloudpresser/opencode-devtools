import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import {
  parseWorkItemId,
  getCommandDefinitions,
  createCommandHook,
} from "./index";

// ─── parseWorkItemId ──────────────────────────────────────────────────────────

describe("parseWorkItemId", () => {
  it("parses a plain numeric ID", () => {
    expect(parseWorkItemId("71036")).toBe("71036");
  });

  it("parses a numeric ID with whitespace", () => {
    expect(parseWorkItemId("  71036  ")).toBe("71036");
  });

  it("parses Azure DevOps URL with ?workitem= param", () => {
    const url =
      "https://dev.azure.com.mcas.ms/VectorVest/VectorVest/_sprints/taskboard/Superior/VectorVest/Tensor%2026.04?workitem=71036";
    expect(parseWorkItemId(url)).toBe("71036");
  });

  it("parses Azure DevOps URL with &workitem= param", () => {
    const url =
      "https://dev.azure.com/Org/Project/_boards/board?other=1&workitem=12345";
    expect(parseWorkItemId(url)).toBe("12345");
  });

  it("is case-insensitive for workitem param", () => {
    const url = "https://dev.azure.com/Org/Project?WorkItem=99999";
    expect(parseWorkItemId(url)).toBe("99999");
  });

  it("returns null for empty string", () => {
    expect(parseWorkItemId("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseWorkItemId("   ")).toBeNull();
  });

  it("returns null for non-numeric, non-URL string", () => {
    expect(parseWorkItemId("some-branch-name")).toBeNull();
  });

  it("returns null for URL without workitem param", () => {
    const url = "https://dev.azure.com/Org/Project/_boards/board?foo=bar";
    expect(parseWorkItemId(url)).toBeNull();
  });
});

// ─── getCommandDefinitions ────────────────────────────────────────────────────

describe("getCommandDefinitions", () => {
  it("returns definitions for both commands", () => {
    const defs = getCommandDefinitions();
    expect(Object.keys(defs)).toContain("superior-workflow");
    expect(Object.keys(defs)).toContain("superior-execute");
  });

  it("has empty templates (handled by command.execute.before)", () => {
    const defs = getCommandDefinitions();
    expect(defs["superior-workflow"].template).toBe("");
    expect(defs["superior-execute"].template).toBe("");
  });

  it("has non-empty descriptions", () => {
    const defs = getCommandDefinitions();
    expect(defs["superior-workflow"].description.length).toBeGreaterThan(0);
    expect(defs["superior-execute"].description.length).toBeGreaterThan(0);
  });
});

// ─── createCommandHook (e2e) ──────────────────────────────────────────────────

// Mock provider module — intercept getProvider to return a fake
const mockFetchWorkItem = mock(async () => ({
  id: 71036,
  title: "Login navigation for RN",
  type: "Bug",
  state: "Active",
  assignedTo: "Luiz Ozorio",
  description: "Wrong password causing hang-up",
  url: "https://dev.azure.com/VectorVest/VectorVest/_workitems/edit/71036",
  fields: {},
  relations: [],
}));

// We need to mock getProvider before importing the module under test.
// Since we already imported from ./index above, we mock the providers module.
mock.module("../providers", () => ({
  getProvider: () => ({
    name: "azure-devops",
    fetchWorkItem: mockFetchWorkItem,
  }),
}));

// Mock formatWorkItemResult to return a predictable string
mock.module("../tools/work-item", () => ({
  formatWorkItemResult: (result: any) =>
    `## Work Item #${result.id}: ${result.title}\nType: ${result.type} | State: ${result.state}`,
}));

// Minimal config for testing
const testConfig = {
  provider: "azure-devops",
  workItem: {
    apiVersion: "7.1",
    fields: [],
    relatedFields: [],
  },
} as any;

// Helper to create a fresh output object
const createOutput = () => ({
  parts: [{ type: "text", text: "original content" }],
});

// Helper to create a mock shell that returns "false" for bare repo check
const createMockShell = (isBare: boolean = false) => {
  const shell: any = (strings: TemplateStringsArray, ...args: any[]) => ({
    text: async () => (isBare ? "true" : "false"),
  });
  return shell;
};

describe("createCommandHook", () => {
  beforeEach(() => {
    mockFetchWorkItem.mockClear();
  });

  describe("command filtering", () => {
    it("ignores unrelated commands", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "some-other-command", sessionID: "s1", arguments: "" },
        output,
      );

      // Output should be untouched
      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toBe("original content");
    });

    it("handles superior-workflow command", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain("Work Item #71036");
    });

    it("handles superior-execute command", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain("Work Item #71036");
    });
  });

  describe("work item context injection", () => {
    it("fetches and injects work item context for numeric ID", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(mockFetchWorkItem).toHaveBeenCalledTimes(1);
      expect(output.parts[0].text).toContain("Work Item #71036");
      expect(output.parts[0].text).toContain("Login navigation for RN");
    });

    it("fetches work item context from Azure DevOps URL", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();
      const url =
        "https://dev.azure.com.mcas.ms/VectorVest/VectorVest/_sprints/taskboard/Superior?workitem=71036";

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: url },
        output,
      );

      expect(mockFetchWorkItem).toHaveBeenCalledTimes(1);
      expect(output.parts[0].text).toContain("Work Item #71036");
    });

    it("shows fallback message when no work item ID provided", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "" },
        output,
      );

      expect(mockFetchWorkItem).not.toHaveBeenCalled();
      expect(output.parts[0].text).toContain("No work item ID provided");
      expect(output.parts[0].text).toContain("/superior-workflow <id-or-url>");
    });

    it("shows fallback message when arguments are undefined", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        {
          command: "superior-workflow",
          sessionID: "s1",
          arguments: undefined as any,
        },
        output,
      );

      expect(output.parts[0].text).toContain("No work item ID provided");
    });

    it("shows error fallback when provider fetch fails", async () => {
      mockFetchWorkItem.mockRejectedValueOnce(new Error("Network timeout"));

      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "99999" },
        output,
      );

      expect(output.parts[0].text).toContain(
        "Failed to auto-fetch work item 99999",
      );
      expect(output.parts[0].text).toContain("Network timeout");
      expect(output.parts[0].text).toContain("work-item");
    });
  });

  describe("template injection", () => {
    it("replaces original output.parts entirely", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).not.toContain("original content");
    });

    it("injects the workflow template content", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      // Verify key sections from superior-workflow.md
      expect(output.parts[0].text).toContain("Superior Workflow");
      expect(output.parts[0].text).toContain("Phase 1");
      expect(output.parts[0].text).toContain("Phase 2");
      expect(output.parts[0].text).toContain("Phase 3");
      expect(output.parts[0].text).toContain("Red/Green Testing");
    });

    it("injects the execute template content", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      // Verify key sections from superior-execute.md
      expect(output.parts[0].text).toContain("Create Worktree");
      expect(output.parts[0].text).toContain("Red Commit");
      expect(output.parts[0].text).toContain("Green Commit");
      expect(output.parts[0].text).toContain("Session Handoff");
    });

    it("workflow template has no unreplaced placeholders", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts[0].text).not.toContain("{{WORK_ITEM_CONTEXT}}");
    });

    it("execute template has no unreplaced placeholders", async () => {
      const hook = createCommandHook(testConfig, "/project", createMockShell());
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts[0].text).not.toContain("{{WORK_ITEM_CONTEXT}}");
      expect(output.parts[0].text).not.toContain("{{WORKTREE_ROOT}}");
      expect(output.parts[0].text).not.toContain("{{SESSION_DIRECTORY}}");
    });
  });

  describe("worktree path injection (superior-execute only)", () => {
    it("injects parent directory as worktree root for regular repos", async () => {
      const root = "/Users/dev/project";
      const hook = createCommandHook(testConfig, root, createMockShell(false));
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      const expectedRoot = join(root, "..");
      expect(output.parts[0].text).toContain(expectedRoot);
      expect(output.parts[0].text).toContain(
        `git worktree add "${expectedRoot}/<branch-name>"`,
      );
    });

    it("injects repo directory as worktree root for bare repos", async () => {
      const root = "/Users/dev/project.git";
      const hook = createCommandHook(testConfig, root, createMockShell(true));
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      // Bare repo: worktree root IS the root dir itself
      expect(output.parts[0].text).toContain(
        `git worktree add "${root}/<branch-name>"`,
      );
    });

    it("injects session directory for absolute path reminders", async () => {
      const root = "/Users/dev/project";
      const hook = createCommandHook(testConfig, root, createMockShell(false));
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      expect(output.parts[0].text).toContain(
        `The session remains in \`${root}\``,
      );
    });

    it("defaults to non-bare when git command fails", async () => {
      const root = "/Users/dev/project";
      // Shell that throws on git command
      const failShell: any = () => ({
        text: async () => {
          throw new Error("git not found");
        },
      });
      const hook = createCommandHook(testConfig, root, failShell);
      const output = createOutput();

      await hook(
        { command: "superior-execute", sessionID: "s1", arguments: "71036" },
        output,
      );

      // Should default to non-bare (parent dir)
      const expectedRoot = join(root, "..");
      expect(output.parts[0].text).toContain(expectedRoot);
    });

    it("does NOT inject worktree paths for superior-workflow", async () => {
      const root = "/Users/dev/project";
      const hook = createCommandHook(testConfig, root, createMockShell(false));
      const output = createOutput();

      await hook(
        { command: "superior-workflow", sessionID: "s1", arguments: "71036" },
        output,
      );

      // Workflow template should not have worktree-related content
      // (it doesn't have the placeholders in the first place)
      expect(output.parts[0].text).not.toContain("WORKTREE_ROOT");
      expect(output.parts[0].text).not.toContain("SESSION_DIRECTORY");
    });
  });
});
