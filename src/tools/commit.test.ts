import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createCommitTool } from "./commit";

// ─── Shell Mock ───────────────────────────────────────────────────────────────

function createMockShell(overrides: {
  statusOutput?: string;
  commitExitCode?: number;
  commitStderr?: string;
  commitStdout?: string;
  logOutput?: string;
  diffStatOutput?: string;
  stageError?: Error;
  statusError?: Error;
} = {}) {
  const {
    statusOutput = "",
    commitExitCode = 0,
    commitStderr = "",
    commitStdout = "",
    logOutput = "abc1234",
    diffStatOutput = " 1 file changed, 2 insertions(+)",
    stageError,
    statusError,
  } = overrides;

  const calls: { args: any[] }[] = [];

  // Tagged template literal mock — captures the template strings
  const $ = (strings: TemplateStringsArray, ...values: any[]) => {
    const command = strings.reduce(
      (acc, str, i) => acc + str + (values[i] ?? ""),
      "",
    );
    calls.push({ args: values });

    const makeResult = (output: string, exitCode = 0, stderr = "") => ({
      text: () => Promise.resolve(output),
      stdout: Buffer.from(output),
      stderr: Buffer.from(stderr),
      exitCode,
      nothrow: () => makeResult(output, exitCode, stderr),
      quiet: () => makeResult(output, exitCode, stderr),
    });

    // Route based on command content
    if (command.includes("status --porcelain")) {
      if (statusError) throw statusError;
      return makeResult(statusOutput);
    }
    if (command.includes("add")) {
      if (stageError) throw stageError;
      return makeResult("");
    }
    if (command.includes("commit")) {
      return makeResult(commitStdout, commitExitCode, commitStderr);
    }
    if (command.includes("log -1")) {
      return makeResult(logOutput);
    }
    if (command.includes("diff --stat")) {
      return makeResult(diffStatOutput);
    }
    return makeResult("");
  };

  return { $, calls };
}

// ─── Signature ────────────────────────────────────────────────────────────────

describe("createCommitTool", () => {
  it("accepts 3 parameters (ToolFactory-compatible)", () => {
    expect(createCommitTool.length).toBe(3);
  });

  it("returns a [name, toolDef] tuple with name 'commit'", () => {
    const { $ } = createMockShell();
    const [name, def] = createCommitTool({}, "/root", $);
    expect(name).toBe("commit");
    expect(def).toBeDefined();
    expect(def.description).toBeTypeOf("string");
    expect(def.execute).toBeTypeOf("function");
  });
});

// ─── Execution ────────────────────────────────────────────────────────────────

describe("commit tool execution", () => {
  it("returns 'No changes to commit.' when git status is clean", async () => {
    const { $ } = createMockShell({ statusOutput: "" });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "test", workdir: "/repo" },
      {} as any,
    );
    expect(result).toBe("No changes to commit.");
  });

  it("returns committed summary on success", async () => {
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      commitExitCode: 0,
      logOutput: "abc1234",
      diffStatOutput: " src/file.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
    });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "fix: thing", workdir: "/repo" },
      {} as any,
    );
    expect(result).toContain("Committed abc1234: fix: thing");
    expect(result).toContain("1 file changed");
  });

  it("returns error with summarized output on commit failure", async () => {
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      commitExitCode: 1,
      commitStderr: "pre-commit hook failed\nsome error detail",
    });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "fix: thing", workdir: "/repo" },
      {} as any,
    );
    expect(result).toContain("Commit failed");
    expect(result).toContain("pre-commit hook");
  });

  it("returns error when commit fails with no output", async () => {
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      commitExitCode: 1,
      commitStderr: "",
      commitStdout: "",
    });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "fix: thing", workdir: "/repo" },
      {} as any,
    );
    expect(result).toContain("Commit failed with no output");
  });

  it("returns error when staging fails", async () => {
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      stageError: new Error("pathspec 'bad' did not match any files"),
    });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "fix: thing", workdir: "/repo", files: ["bad"] },
      {} as any,
    );
    expect(result).toContain("Failed to stage files");
  });

  it("returns error when git status check fails", async () => {
    const { $ } = createMockShell({
      statusError: new Error("not a git repository"),
    });
    const [, def] = createCommitTool({}, "/root", $);
    const result = await def.execute(
      { message: "fix: thing", workdir: "/repo" },
      {} as any,
    );
    expect(result).toContain("Failed to check git status");
  });

  it("includes --no-verify when skipHooks is true", async () => {
    let capturedCommitArgs: any[] = [];
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      commitExitCode: 0,
      logOutput: "abc1234",
      diffStatOutput: " 1 file changed",
    });

    // Wrap $ to capture commit args
    const original$ = $;
    const wrapping$ = (strings: TemplateStringsArray, ...values: any[]) => {
      const command = strings.reduce(
        (acc, str, i) => acc + str + (values[i] ?? ""),
        "",
      );
      if (command.includes("commit")) {
        // The commit args are passed as an array in the template literal
        capturedCommitArgs = values;
      }
      return original$(strings, ...values);
    };

    const [, def] = createCommitTool({}, "/root", wrapping$);
    await def.execute(
      { message: "test: red", workdir: "/repo", skipHooks: true },
      {} as any,
    );

    // The commitArgs array should contain --no-verify
    const argsArray = capturedCommitArgs.find(
      (v) => Array.isArray(v) && v.includes("--no-verify"),
    );
    expect(argsArray).toBeDefined();
  });

  it("does not include --no-verify when skipHooks is false", async () => {
    let capturedCommitArgs: any[] = [];
    const { $ } = createMockShell({
      statusOutput: "M src/file.ts",
      commitExitCode: 0,
      logOutput: "abc1234",
      diffStatOutput: " 1 file changed",
    });

    const original$ = $;
    const wrapping$ = (strings: TemplateStringsArray, ...values: any[]) => {
      const command = strings.reduce(
        (acc, str, i) => acc + str + (values[i] ?? ""),
        "",
      );
      if (command.includes("commit")) {
        capturedCommitArgs = values;
      }
      return original$(strings, ...values);
    };

    const [, def] = createCommitTool({}, "/root", wrapping$);
    await def.execute(
      { message: "fix: green", workdir: "/repo" },
      {} as any,
    );

    const argsArray = capturedCommitArgs.find(
      (v) => Array.isArray(v) && v.includes("--no-verify"),
    );
    expect(argsArray).toBeUndefined();
  });
});
