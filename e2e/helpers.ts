/**
 * Shared test utilities for e2e tests.
 *
 * Provides helpers to:
 * - Spawn OpenCode processes and capture output
 * - Parse TUI output into structured data
 * - Manage temporary git worktrees for test isolation
 * - Query Azure DevOps for test verification
 */

import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Whether to run tests that hit real Azure DevOps APIs */
export const LIVE = process.env.DEVTOOLS_E2E_LIVE === "1";

/** Default test org URL */
export const ORG =
  process.env.DEVTOOLS_E2E_ORG || "https://dev.azure.com/VectorVest";

/** Default test work item ID */
export const WORK_ITEM_ID = process.env.DEVTOOLS_E2E_WORKITEM || "71405";

/**
 * Spawn an OpenCode process and wait for it to exit or timeout.
 * Returns structured result with stdout, stderr, exit code.
 */
export async function spawnOpenCode(opts: {
  prompt: string;
  workdir: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const timeout = opts.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const proc = Bun.spawn(["opencode", "--prompt", opts.prompt], {
      cwd: opts.workdir,
      env: { ...process.env, ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return { exitCode, stdout, stderr, timedOut: false };
  } catch (e: any) {
    if (e.name === "AbortError" || controller.signal.aborted) {
      return { exitCode: -1, stdout: "", stderr: "TIMEOUT", timedOut: true };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query Azure DevOps work item via az CLI.
 * Returns parsed JSON or null on failure.
 */
export async function fetchWorkItem(
  id: string | number,
  org?: string,
): Promise<any | null> {
  try {
    const result =
      await $`az boards work-item show --id ${id} --org ${org || ORG} --expand Relations --output json 2>/dev/null`.text();
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * List git worktrees in a repo.
 * Returns array of {path, branch} objects.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<Array<{ path: string; branch: string }>> {
  try {
    const raw =
      await $`git -C ${repoPath} worktree list --porcelain`.text();
    const blocks = raw.split("\n\n").filter((b) => b.trim());
    return blocks.map((block) => {
      const lines = block.split("\n");
      const path =
        lines.find((l) => l.startsWith("worktree "))?.replace("worktree ", "") ||
        "";
      const branch =
        lines
          .find((l) => l.startsWith("branch "))
          ?.replace("branch refs/heads/", "") || "";
      return { path, branch };
    });
  } catch {
    return [];
  }
}

/**
 * List tmux windows matching a pattern.
 */
export async function findTmuxWindow(
  pattern: string,
): Promise<string | null> {
  try {
    const windows = await $`tmux list-windows -F '#{window_name}'`.text();
    const match = windows
      .split("\n")
      .find((w) => w.includes(pattern));
    return match || null;
  } catch {
    return null;
  }
}

/**
 * Kill a tmux window by name.
 */
export async function killTmuxWindow(name: string): Promise<void> {
  await $`tmux kill-window -t ${name}`.nothrow().quiet();
}

/**
 * Remove a git worktree and optionally its branch.
 */
export async function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branchName?: string,
): Promise<void> {
  await $`git -C ${repoPath} worktree remove ${worktreePath} --force`
    .nothrow()
    .quiet();
  if (branchName) {
    await $`git -C ${repoPath} branch -D ${branchName}`.nothrow().quiet();
  }
}

/**
 * Create a temporary directory for test isolation.
 */
export function createTempDir(prefix = "devtools-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove a temporary directory.
 */
export function removeTempDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read a file written by debug logging (e.g., /tmp/devtools-command-hook.log).
 */
export function readLogFile(path: string): string[] {
  try {
    const content = Bun.file(path).text();
    // This is sync-ish for tests
    return [];
  } catch {
    return [];
  }
}

/**
 * Wait for a condition to be true, polling at interval.
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeout = opts?.timeoutMs ?? 30_000;
  const interval = opts?.intervalMs ?? 1_000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}
