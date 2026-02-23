import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { createWorktreeTool } from "./create-worktree";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const testConfig = {} as any;

// Create a real BunShell scoped to a directory
const shellAt = (cwd: string) => $.cwd(cwd).nothrow();

let tmpRoot: string;
let repoDir: string;
let bareRepoDir: string;
let worktreeCounter = 0;

const uniqueBranch = () => `test-branch-${++worktreeCounter}`;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "devtools-worktree-test-"));

  // Create a regular git repo
  repoDir = join(tmpRoot, "regular-repo");
  mkdirSync(repoDir, { recursive: true });
  const sh = shellAt(repoDir);
  await sh`git init`.quiet();
  await sh`git config user.email "test@test.com"`.quiet();
  await sh`git config user.name "Test"`.quiet();

  // Create initial commit with a yarn.lock
  writeFileSync(join(repoDir, "yarn.lock"), "# yarn lockfile v1\n");
  writeFileSync(join(repoDir, "package.json"), '{"name":"test"}\n');
  await sh`git add -A && git commit -m "initial"`.quiet();

  // Create node_modules with a dummy file
  mkdirSync(join(repoDir, "node_modules", ".cache"), { recursive: true });
  writeFileSync(
    join(repoDir, "node_modules", ".cache", "marker.txt"),
    "exists",
  );

  // Create a bare clone for bare repo tests
  bareRepoDir = join(tmpRoot, "bare-repo.git");
  await shellAt(tmpRoot)`git clone --bare ${repoDir} ${bareRepoDir}`.quiet();
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createWorktreeTool", () => {
  describe("worktree creation", () => {
    it("creates worktree at parent dir for regular repos", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      const expectedDir = join(repoDir, "..", branch);
      expect(result).toContain(`Worktree created at: ${expectedDir}`);
      expect(result).toContain(`Branch: ${branch} (from main)`);
      expect(existsSync(expectedDir)).toBe(true);
      expect(existsSync(join(expectedDir, "package.json"))).toBe(true);

      // Cleanup
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("creates worktree at repo dir for bare repos", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        bareRepoDir,
        shellAt(bareRepoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      const expectedDir = join(bareRepoDir, branch);
      expect(result).toContain(`Worktree created at: ${expectedDir}`);
      expect(existsSync(expectedDir)).toBe(true);

      // Cleanup
      await shellAt(
        bareRepoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("creates worktree at custom worktreeRoot when provided", async () => {
      const branch = uniqueBranch();
      const customRoot = join(tmpRoot, "custom-location");
      mkdirSync(customRoot, { recursive: true });

      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        {
          branchName: branch,
          baseBranch: "main",
          worktreeRoot: customRoot,
        },
        {} as any,
      );

      const expectedDir = join(customRoot, branch);
      expect(result).toContain(`Worktree created at: ${expectedDir}`);
      expect(existsSync(expectedDir)).toBe(true);

      // Cleanup
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("returns error when base branch does not exist", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "nonexistent-branch" },
        {} as any,
      );

      // The tool should still return a result (not throw)
      // and the worktree should not exist
      const expectedDir = join(repoDir, "..", branch);
      expect(existsSync(expectedDir)).toBe(false);
    });
  });

  describe("node_modules symlink", () => {
    it("symlinks node_modules when lockfiles match", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      const expectedDir = join(repoDir, "..", branch);
      const nmPath = join(expectedDir, "node_modules");

      expect(result).toContain("node_modules symlinked (lockfiles match)");
      expect(existsSync(nmPath)).toBe(true);
      expect(lstatSync(nmPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nmPath)).toBe(join(repoDir, "node_modules"));

      // Cleanup
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("symlinks optimistically when no lockfile in worktree", async () => {
      // Create a branch that has no yarn.lock
      const setupBranch = uniqueBranch();
      const sh = shellAt(repoDir);
      await sh`git checkout -b ${setupBranch}`.quiet();
      await sh`git rm yarn.lock`.quiet();
      await sh`git commit -m "remove lockfile"`.quiet();
      await sh`git checkout main`.quiet();

      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: setupBranch },
        {} as any,
      );

      const expectedDir = join(repoDir, "..", branch);
      const nmPath = join(expectedDir, "node_modules");

      expect(result).toContain("node_modules symlinked");
      expect(existsSync(nmPath)).toBe(true);
      expect(lstatSync(nmPath).isSymbolicLink()).toBe(true);

      // Cleanup
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
      await sh`git branch -D ${setupBranch}`.quiet();
    });

    it("warns when no node_modules in session directory", async () => {
      // Use the bare repo — it has no node_modules
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        bareRepoDir,
        shellAt(bareRepoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      expect(result).toContain("no node_modules in session directory");

      // Cleanup
      const expectedDir = join(bareRepoDir, branch);
      await shellAt(
        bareRepoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });
  });

  describe("return value", () => {
    it("returns absolute worktree path", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      const expectedDir = join(repoDir, "..", branch);
      expect(result).toContain(`Worktree created at: ${expectedDir}`);
      // Path should be absolute
      expect(expectedDir.startsWith("/")).toBe(true);

      // Cleanup
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("returns branch and base branch info", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      expect(result).toContain(`Branch: ${branch} (from main)`);

      // Cleanup
      const expectedDir = join(repoDir, "..", branch);
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });

    it("returns dependency status", async () => {
      const branch = uniqueBranch();
      const [, toolDef] = createWorktreeTool(
        testConfig,
        repoDir,
        shellAt(repoDir),
      );

      const result = await toolDef.execute(
        { branchName: branch, baseBranch: "main" },
        {} as any,
      );

      expect(result).toContain("Dependencies:");
      expect(result).toContain(
        "Use this absolute path for all subsequent file operations.",
      );

      // Cleanup
      const expectedDir = join(repoDir, "..", branch);
      await shellAt(
        repoDir,
      )`git worktree remove ${expectedDir} --force`.quiet();
    });
  });
});
