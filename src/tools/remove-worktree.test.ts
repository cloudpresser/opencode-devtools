import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { createRemoveWorktreeTool } from "./remove-worktree";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const testConfig = {} as any;
const shellAt = (cwd: string) => $.cwd(cwd).nothrow();

let tmpRoot: string;
let repoDir: string;
let worktreeCounter = 0;

const uniqueBranch = () => `rm-test-branch-${++worktreeCounter}`;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "devtools-rm-worktree-test-"));

  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  const sh = shellAt(repoDir);
  await sh`git init`.quiet();
  await sh`git config user.email "test@test.com"`.quiet();
  await sh`git config user.name "Test"`.quiet();
  writeFileSync(join(repoDir, "file.txt"), "content\n");
  await sh`git add -A && git commit -m "initial"`.quiet();
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Helper to create a worktree for testing removal
const createTestWorktree = async (branch: string) => {
  const worktreeDir = join(repoDir, "..", branch);
  await shellAt(
    repoDir,
  )`git worktree add ${worktreeDir} -b ${branch} main`.quiet();
  return worktreeDir;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("removeWorktreeTool", () => {
  it("removes an existing worktree", async () => {
    const branch = uniqueBranch();
    const worktreeDir = await createTestWorktree(branch);
    expect(existsSync(worktreeDir)).toBe(true);

    const [, toolDef] = createRemoveWorktreeTool(
      testConfig,
      repoDir,
      shellAt(repoDir),
    );

    const result = await toolDef.execute({ branchName: branch }, {} as any);

    expect(result).toContain(`Worktree removed: ${worktreeDir}`);
    expect(result).toContain(`Branch "${branch}" was preserved`);
    expect(existsSync(worktreeDir)).toBe(false);

    // Verify the branch still exists
    const branches = await shellAt(repoDir)`git branch --list ${branch}`.text();
    expect(branches.trim()).toContain(branch);

    // Cleanup branch
    await shellAt(repoDir)`git branch -D ${branch}`.quiet();
  });

  it("returns error when worktree does not exist", async () => {
    const [, toolDef] = createRemoveWorktreeTool(
      testConfig,
      repoDir,
      shellAt(repoDir),
    );

    const result = await toolDef.execute(
      { branchName: "nonexistent-worktree" },
      {} as any,
    );

    expect(result).toContain("Failed to remove worktree");
  });

  it("force removes worktree with uncommitted changes", async () => {
    const branch = uniqueBranch();
    const worktreeDir = await createTestWorktree(branch);

    // Create uncommitted changes in the worktree
    writeFileSync(join(worktreeDir, "dirty.txt"), "uncommitted\n");

    const [, toolDef] = createRemoveWorktreeTool(
      testConfig,
      repoDir,
      shellAt(repoDir),
    );

    // Without force — should fail
    const failResult = await toolDef.execute({ branchName: branch }, {} as any);
    expect(failResult).toContain("Failed to remove worktree");
    expect(existsSync(worktreeDir)).toBe(true);

    // With force — should succeed
    const result = await toolDef.execute(
      { branchName: branch, force: true },
      {} as any,
    );
    expect(result).toContain(`Worktree removed: ${worktreeDir}`);
    expect(existsSync(worktreeDir)).toBe(false);

    // Cleanup branch
    await shellAt(repoDir)`git branch -D ${branch}`.quiet();
  });

  it("preserves the branch after removal", async () => {
    const branch = uniqueBranch();
    await createTestWorktree(branch);

    const [, toolDef] = createRemoveWorktreeTool(
      testConfig,
      repoDir,
      shellAt(repoDir),
    );

    await toolDef.execute({ branchName: branch }, {} as any);

    // Branch must still exist
    const branches = await shellAt(repoDir)`git branch --list ${branch}`.text();
    expect(branches.trim()).toContain(branch);

    // Cleanup branch
    await shellAt(repoDir)`git branch -D ${branch}`.quiet();
  });

  it("uses custom worktreeRoot when provided", async () => {
    const branch = uniqueBranch();
    const customRoot = join(tmpRoot, "custom-rm");
    mkdirSync(customRoot, { recursive: true });

    // Create worktree at custom location
    const worktreeDir = join(customRoot, branch);
    await shellAt(
      repoDir,
    )`git worktree add ${worktreeDir} -b ${branch} main`.quiet();
    expect(existsSync(worktreeDir)).toBe(true);

    const [, toolDef] = createRemoveWorktreeTool(
      testConfig,
      repoDir,
      shellAt(repoDir),
    );

    const result = await toolDef.execute(
      { branchName: branch, worktreeRoot: customRoot },
      {} as any,
    );

    expect(result).toContain(`Worktree removed: ${worktreeDir}`);
    expect(existsSync(worktreeDir)).toBe(false);

    // Cleanup branch
    await shellAt(repoDir)`git branch -D ${branch}`.quiet();
  });
});
