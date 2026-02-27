import { tool } from "@opencode-ai/plugin";
import { join, resolve } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  copyFileSync,
} from "node:fs";
import type { DevToolsConfig } from "../config";

// ─── Shallow-Copy Node Modules ────────────────────────────────────────────────

/**
 * Creates a shallow copy of node_modules in the worktree directory.
 *
 * Instead of symlinking the entire node_modules/ (which causes TS2742 because
 * workspace symlinks resolve relative to the session dir), we:
 *
 * 1. Create a real node_modules/ directory in the worktree
 * 2. For workspace packages (symlinks with ../../ targets): re-create the same
 *    relative symlink so it resolves to the WORKTREE's own packages
 * 3. For everything else: symlink back to the session dir's copy
 *
 * This gives TypeScript correct path resolution while avoiding a full
 * yarn install (~30-60s) or copying gigabytes of node_modules.
 */
function shallowCopyNodeModules(sessionDir: string, worktreeDir: string): void {
  const srcNM = join(sessionDir, "node_modules");
  const dstNM = join(worktreeDir, "node_modules");
  mkdirSync(dstNM);

  for (const entry of readdirSync(srcNM)) {
    const srcPath = join(srcNM, entry);
    const dstPath = join(dstNM, entry);

    if (entry.startsWith("@")) {
      // Scoped directory — dive into it to handle workspace symlinks
      mkdirSync(dstPath);
      for (const sub of readdirSync(srcPath)) {
        const srcSub = join(srcPath, sub);
        const dstSub = join(dstPath, sub);
        const stat = lstatSync(srcSub);

        if (stat.isSymbolicLink()) {
          const target = readlinkSync(srcSub);
          if (target.startsWith("../../")) {
            // Workspace symlink — re-create with same relative target
            // so it resolves to the worktree's own packages, not session's
            symlinkSync(target, dstSub);
          } else {
            // Non-workspace symlink — point to the session's copy
            symlinkSync(srcSub, dstSub);
          }
        } else {
          // Real directory/file — symlink to session
          symlinkSync(srcSub, dstSub);
        }
      }
    } else {
      // Top-level entry — symlink to session
      symlinkSync(srcPath, dstPath);
    }
  }
}

// ─── Tmux Spawning ────────────────────────────────────────────────────────────

// ─── Tmux Spawn Primitives ────────────────────────────────────────────────────

export interface SpawnInTmuxOptions {
  /** Tmux window name (will be sanitized). */
  windowName: string;
  /** Working directory for the tmux window. */
  cwd: string;
  /** Slash command to dispatch (e.g., "/implement"). */
  command: string;
  /** Positional prompt/args for the command. */
  prompt?: string;
  /** Agent name (omit to use user's default). */
  agentName?: string;
  /** Model ID (omit to use user's default). */
  agentModel?: string;
  /** Bun shell instance. */
  $: any;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Generate a short random pane ID like "x7kQ" for easy tmux identification. */
function randomPaneId(len = 4): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (let i = 0; i < len; i++) id += BASE62[bytes[i] % 62];
  return id;
}

/**
 * Spawn an `opencode run` session in a new tmux window.
 * Shared primitive used by both worktree workflows (via createWorktreeDirect)
 * and direct workflows (via CLI).
 */
export async function spawnInTmux(opts: SpawnInTmuxOptions): Promise<string> {
  const { cwd, command, prompt, agentName, agentModel, $ } = opts;
  const paneId = randomPaneId();
  const windowName = `${opts.windowName.replace(/\//g, "-").slice(0, 32)}-${paneId}`;

  if (!process.env.TMUX) {
    return `Not in tmux. Run manually: cd ${cwd} && opencode`;
  }

  try {
    const cmd = command.replace(/^\//, "");

    // Inject continue_loop_on_deny so the worker doesn't exit on
    // permission rejections (run mode auto-rejects all permission asks).
    const configOverride = JSON.stringify({
      experimental: { continue_loop_on_deny: true },
    });
    let opencodeCmd = `OPENCODE_CONFIG_CONTENT='${configOverride}' opencode run`;
    if (agentName) opencodeCmd += ` --agent ${agentName}`;
    if (agentModel) opencodeCmd += ` --model ${agentModel}`;
    opencodeCmd += ` --command ${cmd}`;
    if (prompt) {
      const escaped = prompt.replace(/'/g, "'\\''");
      opencodeCmd += ` '${escaped}'`;
    }
    // Append exit code for post-mortem debugging
    opencodeCmd += '; echo "\\n=== EXIT CODE: $? ==="';

    // Use Bun.spawn to avoid Bun Shell auto-escaping the command string,
    // which would mangle the internal quotes and semicolons needed by sh -c.
    const proc = Bun.spawn(
      ["tmux", "new-window", "-n", windowName, "-c", cwd, "sh", "-c", opencodeCmd],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;

    // Keep the tmux pane visible after process exits
    await $`tmux set-option -t ${windowName} remain-on-exit on`.nothrow().quiet();
    return `Tmux window '${windowName}' spawned.`;
  } catch (e: any) {
    return `Failed to spawn tmux window: ${e.message}. Run manually: cd ${cwd} && opencode`;
  }
}

/** Worktree-specific wrapper for spawnInTmux. */
interface SpawnTmuxOptions {
  worktreeDir: string;
  branchName: string;
  prompt?: string;
  $: any;
  workerCommand?: string;
  agentName?: string;
  agentModel?: string;
}

async function spawnTmuxSession(opts: SpawnTmuxOptions): Promise<string> {
  return spawnInTmux({
    windowName: opts.branchName,
    cwd: opts.worktreeDir,
    command: opts.workerCommand || "/implement",
    prompt: opts.prompt,
    agentName: opts.agentName || "implement",
    agentModel: opts.agentModel || "opencode/claude-opus-4-6",
    $: opts.$,
  });
}

// ─── Core Worktree Creation ───────────────────────────────────────────────────

export interface WorktreeOptions {
  branchName: string;
  baseBranch: string;
  prompt?: string;
  worktreeRoot?: string;
  /** Custom slash command to run in the tmux session (default: /implement) */
  workerCommand?: string;
  /** Agent name to use in the worker session (default: "implement") */
  workerAgentName?: string;
  /** Model ID to use in the worker session (default: "opencode/claude-opus-4-6") */
  workerAgentModel?: string;
  /** If true, reuse existing worktree/branch instead of failing */
  reuseExisting?: boolean;
  root: string;
  $: any;
  /** Optional logger for diagnostics */
  log?: { info(tag: string, msg: string): void; warn(tag: string, msg: string): void; error(tag: string, msg: string): void };
}

export interface WorktreeResult {
  success: boolean;
  message: string;
  worktreeDir: string;
}

/**
 * Creates a git worktree with proper dependency setup and optional tmux session.
 *
 * This is the shared core logic used by both:
 * - The `create-worktree` tool (when agent calls it)
 * - The command hook's deterministic path (when base branch is provided)
 */
export async function createWorktreeDirect(
  opts: WorktreeOptions,
): Promise<WorktreeResult> {
  const { branchName, baseBranch, prompt, root, $ } = opts;
  const _log = opts.log ?? { info: () => {}, warn: () => {}, error: () => {} };
  _log.info("worktree", `createWorktreeDirect: branch=${branchName} base=${baseBranch} reuse=${opts.reuseExisting ?? false} root=${root}`);

  // 1. Determine worktree root
  let worktreeRoot = opts.worktreeRoot;
  if (!worktreeRoot) {
    let isBare = false;
    try {
      const result =
        await $`git -C ${root} rev-parse --is-bare-repository`.text();
      isBare = result.trim() === "true";
    } catch {
      // default non-bare
    }
    worktreeRoot = isBare ? root : join(root, "..");
  }

  const worktreeDir = join(worktreeRoot, branchName);

  // 2. Create worktree (with optional reuse support)
  try {
    if (opts.reuseExisting) {
      // Check if worktree already exists at this path
      if (existsSync(join(worktreeDir, ".git"))) {
        // Worktree exists at expected path — reuse it
        _log.info("worktree", `reuse: worktree exists at expected path ${worktreeDir}`);
        await $`git -C ${worktreeDir} checkout ${branchName}`
          .nothrow()
          .quiet();
      } else {
        // Check if branch already has a worktree elsewhere
        const worktreeListRaw =
          await $`git -C ${root} worktree list --porcelain`
            .text()
            .catch(() => "");
        // Parse porcelain output: blocks separated by blank lines,
        // each block has "worktree <path>" and "branch refs/heads/<name>"
        let existingWorktreePath: string | null = null;
        const blocks = worktreeListRaw.split("\n\n");
        for (const block of blocks) {
          const branchLine = block
            .split("\n")
            .find((l: string) => l.startsWith("branch "));
          if (
            branchLine &&
            branchLine === `branch refs/heads/${branchName}`
          ) {
            const wtLine = block
              .split("\n")
              .find((l: string) => l.startsWith("worktree "));
            if (wtLine) {
              existingWorktreePath = wtLine.replace("worktree ", "");
            }
            break;
          }
        }

        _log.info("worktree", `reuse: worktree list scan found=${existingWorktreePath ?? "(none)"} root=${root}`);
        if (existingWorktreePath) {
          // Branch is checked out somewhere (worktree or main tree) — reuse it.
          // This handles the common case where the user has the branch checked
          // out in the main working directory (e.g. staging).
          _log.info("worktree", `reuse: spawning worker at ${existingWorktreePath}`);
          const tmuxResult = await spawnTmuxSession({
            worktreeDir: existingWorktreePath,
            branchName,
            prompt,
            $,
            workerCommand: opts.workerCommand,
            agentName: opts.workerAgentName,
            agentModel: opts.workerAgentModel,
          });
          return {
            success: true,
            message: `Branch '${branchName}' already has a worktree at ${existingWorktreePath}. Reusing it.\n${tmuxResult}`,
            worktreeDir: existingWorktreePath,
          };
        }

        // Check if branch exists without a worktree
        const branchCheck =
          await $`git -C ${root} branch --list ${branchName}`.text();
        if (branchCheck.trim()) {
          // Branch exists, no worktree — create worktree for existing branch
          _log.info("worktree", `branch ${branchName} exists, creating worktree at ${worktreeDir}`);
          const result =
            await $`git -C ${root} worktree add ${worktreeDir} ${branchName}`
              .nothrow()
              .quiet();
          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim();
            return {
              success: false,
              message: `Failed to create worktree for existing branch: ${stderr || "unknown error"}`,
              worktreeDir,
            };
          }
        } else {
          // Neither branch nor worktree exist — create both
          _log.info("worktree", `new branch+worktree: ${branchName} from ${baseBranch} at ${worktreeDir}`);
          const result =
            await $`git -C ${root} worktree add ${worktreeDir} -b ${branchName} ${baseBranch}`
              .nothrow()
              .quiet();
          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString().trim();
            return {
              success: false,
              message: `Failed to create worktree: ${stderr || "unknown error"}`,
              worktreeDir,
            };
          }
        }
      }
    } else {
      // Check if branch already exists (e.g. from a previous run)
      const branchCheck =
        await $`git -C ${root} rev-parse --verify ${branchName}`.nothrow().quiet();
      const branchExists = branchCheck.exitCode === 0;

      const result = branchExists
        ? await $`git -C ${root} worktree add ${worktreeDir} ${branchName}`
            .nothrow()
            .quiet()
        : await $`git -C ${root} worktree add ${worktreeDir} -b ${branchName} ${baseBranch}`
            .nothrow()
            .quiet();

      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim();
        return {
          success: false,
          message: `Failed to create worktree: ${stderr || "unknown error"}`,
          worktreeDir,
        };
      }
    }
  } catch (e: any) {
    return {
      success: false,
      message: `Failed to create worktree: ${e.message}`,
      worktreeDir,
    };
  }

  // 3. Set up node_modules via shallow copy or yarn install
  const sessionLock = join(root, "yarn.lock");
  const worktreeLock = join(worktreeDir, "yarn.lock");
  const sessionNodeModules = join(root, "node_modules");
  const worktreeNodeModules = join(worktreeDir, "node_modules");

  let depsStatus: string;
  _log.info("worktree", `setting up deps: sessionModules=${existsSync(sessionNodeModules)} worktreeModules=${existsSync(worktreeNodeModules)}`);
  try {
    if (existsSync(worktreeNodeModules)) {
      depsStatus = "node_modules already present (reused worktree)";
    } else if (!existsSync(sessionNodeModules)) {
      depsStatus =
        "no node_modules in session directory — run yarn install manually";
    } else if (existsSync(sessionLock) && existsSync(worktreeLock)) {
      const sessionLockContent = readFileSync(sessionLock);
      const worktreeLockContent = readFileSync(worktreeLock);

      if (sessionLockContent.equals(worktreeLockContent)) {
        shallowCopyNodeModules(root, worktreeDir);
        depsStatus =
          "node_modules shallow-copied (workspace symlinks re-created)";
      } else {
        await $`cd ${worktreeDir} && yarn install`.quiet();
        depsStatus = "yarn install completed (lockfiles differ)";
      }
    } else {
      // No lockfile comparison possible — shallow copy optimistically
      shallowCopyNodeModules(root, worktreeDir);
      depsStatus =
        "node_modules shallow-copied (no lockfile comparison available)";
    }
  } catch (e: any) {
    depsStatus = `Failed to set up dependencies: ${e.message}. Run yarn install manually in the worktree.`;
  }

  // 4. Symlink .husky/_/ for pre-commit hook support.
  // Husky v8 generates .husky/_/husky.sh during `yarn install` (via
  // the `prepare` script). It's git-ignored, so new worktrees don't
  // have it — causing pre-commit hooks to fail.
  try {
    const huskySource = join(root, ".husky", "_");
    const huskyTarget = join(worktreeDir, ".husky", "_");
    if (
      existsSync(huskySource) &&
      existsSync(join(worktreeDir, ".husky")) &&
      !existsSync(huskyTarget)
    ) {
      symlinkSync(huskySource, huskyTarget);
    }
  } catch {
    // Non-fatal — hooks may fail but worktree is still usable
  }

  // 5. Copy .devtools.jsonc to worktree (it's gitignored, needed for
  // superiorWorkflow flag and other config in the worker session)
  try {
    for (const name of [".devtools.jsonc", ".devtools.json"]) {
      const src = join(root, name);
      const dst = join(worktreeDir, name);
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst);
      }
    }
  } catch {
    // Non-fatal — worker session falls back to defaults
  }

  // 6. Fix relative plugin paths in opencode.json.
  // The worktree may live at a different directory depth than the source
  // repo, so relative paths like "../../../some-plugin" break. We resolve
  // them to absolute paths using the source repo as the base.
  try {
    const ocConfigPath = join(worktreeDir, "opencode.json");
    if (existsSync(ocConfigPath)) {
      const ocConfig = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
      if (Array.isArray(ocConfig.plugin)) {
        let changed = false;
        ocConfig.plugin = ocConfig.plugin.map((p: string) => {
          if (typeof p === "string" && p.startsWith(".")) {
            changed = true;
            return resolve(root, p);
          }
          return p;
        });
        if (changed) {
          writeFileSync(ocConfigPath, JSON.stringify(ocConfig, null, 2) + "\n");
        }
      }
    }
  } catch {
    // Non-fatal — plugin may fail to load but worktree is still usable
  }

  // 6. Spawn new OpenCode session in tmux window
  _log.info("worktree", `deps: ${depsStatus}`);
  _log.info("worktree", `spawning tmux: dir=${worktreeDir} branch=${branchName} prompt=${prompt} workerCmd=${opts.workerCommand ?? "/implement"}`);
  const tmuxResult = await spawnTmuxSession({
    worktreeDir,
    branchName,
    prompt,
    $,
    workerCommand: opts.workerCommand,
    agentName: opts.workerAgentName,
    agentModel: opts.workerAgentModel,
  });
  _log.info("worktree", `tmux: ${tmuxResult}`);

  return {
    success: true,
    message: [
      `Worktree created at: ${worktreeDir}`,
      `Branch: ${branchName} (from ${baseBranch})`,
      `Dependencies: ${depsStatus}`,
      tmuxResult,
      "",
      "This session's setup is complete. Implementation continues in the new session.",
    ].join("\n"),
    worktreeDir,
  };
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export function createWorktreeTool(
  _config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "create-worktree",
    tool({
      description:
        "Create a git worktree for a branch and set up node_modules. " +
        "Returns the absolute worktree path. Automatically detects bare " +
        "vs regular repos, shallow-copies node_modules with proper " +
        "workspace symlink resolution, and spawns a new OpenCode " +
        "session in a tmux window.",
      args: {
        branchName: tool.schema.string(),
        baseBranch: tool.schema.string(),
        worktreeRoot: tool.schema.optional(tool.schema.string()),
        prompt: tool.schema
          .optional(tool.schema.string())
          .describe(
            "Work item ID or arguments to pass to the worker in the new tmux session",
          ),
      },
      async execute(args) {
        const result = await createWorktreeDirect({
          branchName: args.branchName,
          baseBranch: args.baseBranch,
          worktreeRoot: args.worktreeRoot,
          prompt: args.prompt,
          root,
          $,
        });
        return result.message;
      },
    }),
  ] as const;
}
