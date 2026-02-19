import { tool, type Plugin } from "@opencode-ai/plugin";
import { Terminal } from "bun-pty";
import path from "node:path";

// ─── Shared PTY Session Manager ─────────────────────────────────────────────
interface PTYSession {
  id: string;
  title: string;
  terminal: Terminal;
  buffer: string[];
  status: "running" | "exited" | "killed";
  exitCode?: number;
  pid: number;
  createdAt: Date;
}

const MAX_BUFFER_LINES = 50_000;

class SessionManager {
  private sessions = new Map<string, PTYSession>();

  spawn(opts: {
    command: string;
    args: string[];
    cwd: string;
    title: string;
    env?: Record<string, string>;
  }): PTYSession {
    const id = `tensor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const terminal = new Terminal(opts.command, opts.args, {
      cwd: opts.cwd,
      name: "xterm-256color",
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    const session: PTYSession = {
      id,
      title: opts.title,
      terminal,
      buffer: [],
      status: "running",
      pid: terminal.pid,
      createdAt: new Date(),
    };

    terminal.onData((data: string) => {
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.length > 0) {
          session.buffer.push(line);
          if (session.buffer.length > MAX_BUFFER_LINES) {
            session.buffer.shift();
          }
        }
      }
    });

    terminal.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = "exited";
      session.exitCode = exitCode;
    });

    this.sessions.set(id, session);
    return session;
  }

  get(id: string): PTYSession | undefined {
    return this.sessions.get(id);
  }

  findByTitle(title: string): PTYSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.title === title && session.status === "running") {
        return session;
      }
    }
    return undefined;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status === "running") {
      session.terminal.kill();
      session.status = "killed";
    }
    this.sessions.delete(id);
    return true;
  }

  list(): PTYSession[] {
    return Array.from(this.sessions.values());
  }

  readBuffer(
    id: string,
    opts: { offset?: number; limit?: number; pattern?: string },
  ): { lines: string[]; totalLines: number; matchedLines: number } | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    let lines = session.buffer;
    const totalLines = lines.length;

    if (opts.pattern) {
      try {
        const regex = new RegExp(opts.pattern, "i");
        lines = lines.filter((l) => regex.test(l));
      } catch {
        // Invalid regex, return all
      }
    }

    const matchedLines = lines.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 500;
    lines = lines.slice(offset, offset + limit);

    return { lines, totalLines, matchedLines };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const stripAnsi = (str: string): string =>
  str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
    "",
  );

const ERROR_FILTER =
  /\b(error|Error|ERROR|FAIL|fail|Failed|failed|Warning|WARN|TypeError|SyntaxError|ReferenceError|RangeError|Invariant Violation|BUNDLE|Unable to resolve|Module not found|Failed to compile|Build Error)\b/;

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const TensorTools: Plugin = async ({ $, directory }) => {
  const manager = new SessionManager();
  const root = directory;

  return {
    tool: {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // DEV SERVER - Start/Stop
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "dev-server_start": tool({
        description:
          "Start a development server (Expo mobile or Next.js web). " +
          "If a server of the same type is already running, returns its info instead of spawning a new one. " +
          "Automatically finds an available port if the default is in use. " +
          "Multiple agents share the same server instance.",
        args: {
          server: tool.schema.enum(["expo", "nextjs"]),
          port: tool.schema.optional(tool.schema.number()),
        },
        async execute(args) {
          const config = {
            expo: {
              cwd: path.join(root, "apps", "mobile"),
              command: "yarn",
              args: ["dev", "--ios"],
              title: "Expo Dev Server",
              portFlag: "--port",
              defaultPort: 8081,
            },
            nextjs: {
              cwd: path.join(root, "apps", "next"),
              command: "yarn",
              args: ["dev"],
              title: "Next.js Dev Server",
              portFlag: "-p",
              defaultPort: 3000,
            },
          };

          const cfg = config[args.server];

          // Check if a server of this type is already running in our session manager
          const existing = manager.findByTitle(cfg.title);
          if (existing && existing.status === "running") {
            const buf = manager.readBuffer(existing.id, { limit: 50 });
            const lines = buf?.lines ?? [];
            // Try to find the port from the output
            const portMatch = lines
              .join("\n")
              .match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
            const runningPort = portMatch ? portMatch[1] : "unknown";
            return [
              `Server already running (shared session).`,
              `Type: ${cfg.title}`,
              `Port: ${runningPort}`,
              `Session: ${existing.id} (pid: ${existing.pid})`,
              `Use server-logs and server-errors tools to monitor.`,
            ].join("\n");
          }

          // Kill any dead session for this server type
          if (existing) {
            manager.kill(existing.id);
          }

          // Find an available port
          const findAvailablePort = async (
            startPort: number,
          ): Promise<number> => {
            for (let p = startPort; p < startPort + 20; p++) {
              try {
                const result = await Bun.$`lsof -ti :${p} 2>/dev/null`
                  .quiet()
                  .text();
                if (!result.trim()) return p; // Port is free
              } catch {
                return p; // lsof failed = port is free
              }
            }
            return startPort; // Fallback
          };

          const requestedPort = args.port ?? cfg.defaultPort;
          const port = await findAvailablePort(requestedPort);

          // Kill any existing process on the target port
          try {
            const pids = (
              await Bun.$`lsof -ti :${port} 2>/dev/null`.quiet().text()
            ).trim();
            if (pids) {
              await Bun.$`kill -9 ${pids} 2>/dev/null || true`.quiet();
              await new Promise((r) => setTimeout(r, 500));
            }
          } catch {
            // Ignore
          }

          // For Expo, also kill the app in the simulator
          if (args.server === "expo") {
            try {
              await Bun.$`xcrun simctl terminate booted com.vectorvest.mobile 2>/dev/null || true`.quiet();
            } catch {
              // Ignore
            }
          }

          const cmdArgs = [...cfg.args, cfg.portFlag, String(port)];

          const session = manager.spawn({
            command: cfg.command,
            args: cmdArgs,
            cwd: cfg.cwd,
            title: cfg.title,
          });

          // Wait for server to be fully ready (connected to client)
          const readyPatterns = {
            expo: [
              /iOS Bundled \d+ms/, // Bundle sent to simulator
              /LOG\s/, // App is running and logging
            ],
            nextjs: [
              /Ready in/, // Next.js ready signal
              /✓ Ready/, // Alternative ready signal
            ],
          };

          const errorPatterns = [
            /error/i,
            /BUNDLE ERROR/i,
            /Failed to compile/i,
            /Unable to resolve/i,
            /Cannot find module/i,
          ];

          const patterns = readyPatterns[args.server];
          const TIMEOUT_MS = 180_000; // 3 minutes for full bundle
          const POLL_MS = 1_000;
          const startTime = Date.now();
          let ready = false;
          let lastCheckedLine = 0;

          while (Date.now() - startTime < TIMEOUT_MS) {
            if (session.status !== "running") {
              const tail = session.buffer.slice(-20).map(stripAnsi).join("\n");
              return `Server exited unexpectedly (exit code: ${session.exitCode}).\n\n${tail}`;
            }

            // Check new lines since last poll
            const currentLines = session.buffer.length;
            if (currentLines > lastCheckedLine) {
              const newLines = session.buffer
                .slice(lastCheckedLine)
                .map(stripAnsi);

              for (const line of newLines) {
                if (patterns.some((p) => p.test(line))) {
                  ready = true;
                  break;
                }
              }
              lastCheckedLine = currentLines;
            }

            if (ready) break;
            await new Promise((r) => setTimeout(r, POLL_MS));
          }

          // Grab the last meaningful lines (skip progress bars and QR code)
          const recentLines = session.buffer
            .slice(-15)
            .map(stripAnsi)
            .filter((l) => !l.match(/^[▄▀█▓░ ]{5,}$/) && l.trim().length > 0)
            .slice(-5)
            .join("\n");

          if (!ready) {
            return [
              `Server started but readiness not confirmed within ${TIMEOUT_MS / 1000}s.`,
              `Type: ${cfg.title}`,
              `Port: ${port}`,
              `Session: ${session.id} (pid: ${session.pid})`,
              "",
              "Recent output:",
              recentLines || "(no output)",
              "",
              "Use server-logs and server-errors tools to investigate.",
            ].join("\n");
          }

          return [
            `Server ready: ${cfg.title}`,
            `Port: ${port}`,
            `Session: ${session.id} (pid: ${session.pid})`,
            "",
            recentLines,
            "",
            "Use server-logs and server-errors tools to monitor.",
          ].join("\n");
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // SERVER LOGS
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "server-logs": tool({
        description:
          "Get logs from a running Expo or Next.js dev server. " +
          "The dev server must have been started with the dev-server tool. " +
          "Supports regex filtering, pagination (offset + lineCount), and verbose mode. " +
          "Use errorsOnly to filter to error/warning lines.",
        args: {
          server: tool.schema.enum(["expo", "next"]),
          pattern: tool.schema.optional(tool.schema.string()),
          offset: tool.schema.optional(tool.schema.number()),
          lineCount: tool.schema.optional(tool.schema.number()),
          verbose: tool.schema.optional(tool.schema.boolean()),
          errorsOnly: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const titleMap = {
            expo: "Expo Dev Server",
            next: "Next.js Dev Server",
          };
          const session = manager.findByTitle(titleMap[args.server]);
          if (!session) {
            return `No running ${args.server} dev server found. Start one with dev-server_start first.`;
          }

          // If errorsOnly, use ERROR_FILTER as the pattern (overrides user pattern)
          const filterPattern = args.errorsOnly
            ? ERROR_FILTER.source
            : args.pattern;

          const limit = args.lineCount ?? 100;
          const offset = args.offset ?? 0;
          const result = manager.readBuffer(session.id, {
            offset,
            limit,
            pattern: filterPattern,
          });

          if (!result) return "Session not found.";

          let lines = result.lines;
          if (!args.verbose) {
            lines = lines
              .map(stripAnsi)
              .filter((l: string) => l.trim().length > 0);
          }

          if (args.errorsOnly && lines.length === 0) {
            return `No errors found in ${args.server} server output.`;
          }

          const header = [
            `=== ${titleMap[args.server]} Logs${args.errorsOnly ? " (errors only)" : ""} ===`,
            `Session: ${session.id} | Status: ${session.status}`,
            `Lines: ${offset + 1}-${offset + lines.length} of ${result.totalLines}`,
            filterPattern
              ? `Filter: /${filterPattern}/ (${result.matchedLines} matches)`
              : "",
            "---",
          ]
            .filter(Boolean)
            .join("\n");

          const numbered = lines
            .map(
              (l: string, i: number) =>
                `${String(offset + i + 1).padStart(5)} | ${l}`,
            )
            .join("\n");

          const remaining = result.matchedLines - offset - lines.length;
          const footer =
            remaining > 0
              ? `\n--- ${remaining} more lines. Use offset=${offset + lines.length} to continue.`
              : "";

          return header + "\n" + numbered + footer;
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // CHECK TYPES
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "check-types": tool({
        description:
          "Run TypeScript type checking on the monorepo. " +
          "Returns errors found or confirms no errors. " +
          "Use branchOnly for faster incremental checks (only packages changed on current branch).",
        args: {
          compact: tool.schema.optional(tool.schema.boolean()),
          branchOnly: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const compact = args.compact !== false; // default true
          const mode = args.branchOnly ? "branch" : "full";
          try {
            const envWithBin = {
              ...process.env,
              PATH: `${root}/node_modules/.bin:${process.env.PATH}`,
            };
            const result = args.branchOnly
              ? await $`cd ${root} && bash check-branch-types.sh 2>&1`
                  .env(envWithBin)
                  .nothrow()
                  .quiet()
              : await $`cd ${root} && yarn check-types 2>&1`.nothrow().quiet();
            const output = stripAnsi(result.stdout.toString());

            if (result.exitCode === 0) {
              // Extract package count from lerna output if available
              const pkgMatch = output.match(
                /(\d+) packages? ran check-types successfully/,
              );
              const count = pkgMatch ? ` (${pkgMatch[1]} packages)` : "";
              return `Type check passed${count}. No errors found. [${mode}]`;
            }

            // Type errors — parse and format
            const lines = output.split("\n");

            if (compact) {
              // Group errors by file for compact output
              const errors: string[] = [];
              const seen = new Set<string>();

              for (const line of lines) {
                // Match TypeScript errors: path(line,col): error TS...
                // or tsup/tsc format: path:line:col - error TS...
                const tsMatch = line.match(
                  /([^(\s]+)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/,
                );
                const tscMatch = line.match(
                  /([^:\s]+):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.+)/,
                );
                const m = tsMatch || tscMatch;
                if (m) {
                  const key = `${m[1]}:${m[2]} ${m[4]}`;
                  if (!seen.has(key)) {
                    seen.add(key);
                    errors.push(`${m[1]}:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`);
                  }
                }
              }

              if (errors.length > 0) {
                return [
                  `Type check FAILED: ${errors.length} error${errors.length > 1 ? "s" : ""} [${mode}]`,
                  "",
                  ...errors.slice(0, 100),
                ].join("\n");
              }
            }

            // Non-compact or no TS errors matched — return filtered output
            const meaningful = lines.filter(
              (l: string) =>
                l.includes("error TS") ||
                l.includes("Error:") ||
                l.includes("FAIL") ||
                l.startsWith("error") ||
                l.trim() === "",
            );

            return [
              `Type check FAILED (exit code: ${result.exitCode}) [${mode}]`,
              "",
              ...(meaningful.length > 5
                ? meaningful.slice(0, 200)
                : lines.slice(-100)),
            ].join("\n");
          } catch (e: any) {
            return `Type check execution error: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LINT
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      lint: tool({
        description:
          "Run ESLint on the project. By default lints only files changed since last commit. " +
          "Returns errors found or confirms no errors.",
        args: {
          all: tool.schema.optional(tool.schema.boolean()),
          staged: tool.schema.optional(tool.schema.boolean()),
          fix: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const lintArgs = ["lint"];
          if (args.all) lintArgs.push("--all");
          if (args.staged) lintArgs.push("--staged");
          if (args.fix) lintArgs.push("--fix");

          try {
            const result = await $`cd ${root} && yarn ${lintArgs} 2>&1`
              .nothrow()
              .quiet();
            const output = stripAnsi(result.stdout.toString());
            const exitCode = result.exitCode;

            if (exitCode === 0) {
              if (output.includes("No TypeScript/JavaScript files to lint")) {
                return "Lint passed. No files to lint.";
              }
              return "Lint passed. No errors found.";
            }

            // Parse ESLint output for compact summary
            const lines = output.split("\n");
            const problemMatch = output.match(
              /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/,
            );

            if (problemMatch) {
              // Filter to only file paths + error lines + summary
              const meaningful = lines.filter(
                (l: string) =>
                  l.startsWith("/") ||
                  l.match(/^\s+\d+:\d+/) ||
                  l.match(/^\u2716/) ||
                  l.trim() === "",
              );
              return [
                `Lint FAILED: ${problemMatch[1]} problems (${problemMatch[2]} errors, ${problemMatch[3]} warnings)`,
                "",
                ...meaningful.slice(0, 200),
              ].join("\n");
            }

            // Fallback: return raw output (trimmed)
            return output.slice(0, 10_000);
          } catch (e: any) {
            return `Lint execution error: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // GENERATE
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      generate: tool({
        description:
          "Run the Tensor code generator (yarn generate --non-interactive). " +
          "MUST be used before creating any new features, views, models, viewmodels, " +
          "queries, mutations, or network packages. " +
          "Available templates: feature, simple-feature, view, view-model, model, " +
          "query, mutation, network, context, adr, feature-story, view-story, " +
          "query-story, mutation-story.",
        args: {
          template: tool.schema.string(),
          name: tool.schema.string(),
          parent: tool.schema.optional(tool.schema.string()),
          isStreaming: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const cmdArgs = [
            "generate",
            "--non-interactive",
            "--template",
            args.template,
            "--name",
            args.name,
          ];
          if (args.parent) cmdArgs.push("--parent", args.parent);
          if (args.isStreaming !== undefined)
            cmdArgs.push("--isStreaming", String(args.isStreaming));

          try {
            const result = await $`cd ${root} && yarn ${cmdArgs} 2>&1`
              .nothrow()
              .quiet();
            const output = stripAnsi(result.stdout.toString());
            const exitCode = result.exitCode;

            if (exitCode === 0) {
              // Extract meaningful output: generated file paths, skip yarn/lerna noise
              const lines = output.split("\n");
              const generated = lines.filter(
                (l: string) =>
                  l.includes("Generated") ||
                  l.includes("created") ||
                  l.includes("Created") ||
                  l.includes("packages/") ||
                  l.includes("apps/") ||
                  l.includes("Successfully"),
              );

              if (generated.length > 0) {
                return [
                  `Generator completed: ${args.template} "${args.name}"`,
                  "",
                  ...generated,
                ].join("\n");
              }

              // Fallback: return last meaningful lines
              const meaningful = lines
                .filter(
                  (l: string) =>
                    l.trim().length > 0 &&
                    !l.includes("yarn ") &&
                    !l.includes("$ tensor") &&
                    !l.includes("Done in"),
                )
                .slice(-20);

              return [
                `Generator completed: ${args.template} "${args.name}"`,
                "",
                ...meaningful,
              ].join("\n");
            }

            // Failure — return full output
            return [
              `Generator FAILED (exit code: ${exitCode}): ${args.template} "${args.name}"`,
              "",
              output.slice(0, 5_000),
            ].join("\n");
          } catch (e: any) {
            return `Generator execution error: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // CREATE PR
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "create-pr": tool({
        description:
          "Create a pull request using @cloudpresser/create-pr CLI tool. " +
          "Auto-detects org/project/repo from git remote and .cloudpresser config. " +
          "Handles interactive prompts automatically.",
        args: {
          title: tool.schema.optional(tool.schema.string()),
          body: tool.schema.optional(tool.schema.string()),
          draft: tool.schema.optional(tool.schema.boolean()),
          targetBranch: tool.schema.optional(tool.schema.string()),
          baseBranch: tool.schema.optional(tool.schema.string()),
        },
        async execute(args) {
          const cmdArgs = ["@cloudpresser/create-pr"];
          if (args.title) cmdArgs.push("--title", args.title);
          if (args.body) cmdArgs.push("--description", args.body);
          if (args.draft) cmdArgs.push("--draft");
          const target = args.targetBranch || args.baseBranch;
          if (target) cmdArgs.push("--targetBranch", target);

          return new Promise<string>((resolve) => {
            const terminal = new Terminal("bunx", cmdArgs, {
              cwd: root,
              name: "xterm-256color",
              env: process.env as Record<string, string>,
            });

            const output: string[] = [];
            let resolved = false;
            const timeout = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                terminal.kill();
                resolve(
                  `PR creation timed out after 180s.\n\n${output.map(stripAnsi).join("\n")}`,
                );
              }
            }, 180_000);

            terminal.onData((data: string) => {
              output.push(data);
              const clean = stripAnsi(data);

              // Auto-answer interactive prompts
              if (/edit the pull request title\?/i.test(clean)) {
                terminal.write("n\n");
              } else if (/edit the pull request description\?/i.test(clean)) {
                terminal.write("n\n");
              } else if (/create (the )?pull request\?/i.test(clean)) {
                terminal.write("y\n");
              }
            });

            terminal.onExit(({ exitCode }: { exitCode: number }) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timeout);

              const fullOutput = output.map(stripAnsi).join("\n");

              // Try to extract PR URL
              const urlMatch = fullOutput.match(
                /https:\/\/dev\.azure\.com[^\s)]+/,
              );

              if (exitCode === 0 && urlMatch) {
                const titleMatch = fullOutput.match(/Title:\s*(.+)/);
                const lines = [`PR created: ${urlMatch[0]}`];
                if (titleMatch) lines.push(`Title: ${titleMatch[1].trim()}`);
                if (args.draft) lines.push("(draft)");
                resolve(lines.join("\n"));
              } else if (exitCode === 0) {
                const lines = fullOutput
                  .split("\n")
                  .filter(
                    (l) =>
                      l.trim().length > 0 &&
                      !l.includes("┌") &&
                      !l.includes("└") &&
                      !l.includes("│") &&
                      !l.includes("─") &&
                      !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l),
                  );
                resolve(lines.slice(-10).join("\n"));
              } else {
                const errorLines = fullOutput
                  .split("\n")
                  .filter(
                    (l) =>
                      l.toLowerCase().includes("error") ||
                      l.toLowerCase().includes("fail") ||
                      l.toLowerCase().includes("invalid") ||
                      l.toLowerCase().includes("unauthorized"),
                  );
                resolve(
                  `PR creation failed (exit code: ${exitCode}).\n${errorLines.length > 0 ? errorLines.join("\n") : fullOutput.slice(-500)}`,
                );
              }
            });
          });
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // RUN TESTS
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "run-tests": tool({
        description:
          "Run the project test suite using yarn test. " +
          "Optionally scope to a specific package name. " +
          "Returns a compact summary on success, detailed failures on error.",
        args: {
          package: tool.schema.optional(tool.schema.string()),
          watch: tool.schema.optional(tool.schema.boolean()),
          coverage: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          if (args.watch) {
            const existing = manager.findByTitle("Test Watch");
            if (existing) manager.kill(existing.id);

            const cmdArgs = ["test"];
            if (args.package) cmdArgs.push(args.package);
            cmdArgs.push("--", "--watch");

            const session = manager.spawn({
              command: "yarn",
              args: cmdArgs,
              cwd: root,
              title: "Test Watch",
            });

            await new Promise((r) => setTimeout(r, 3000));
            const buf = session.buffer.slice(-10).map(stripAnsi).join("\n");

            return [
              `Test watch started.`,
              `Session: ${session.id} (pid: ${session.pid})`,
              "",
              buf || "(starting...)",
            ].join("\n");
          }

          const cmdArgs = ["test"];
          if (args.package) cmdArgs.push(args.package);
          if (args.coverage) cmdArgs.push("--", "--coverage");

          try {
            const result = await $`cd ${root} && yarn ${cmdArgs} 2>&1`
              .nothrow()
              .quiet();
            const raw = stripAnsi(result.stdout.toString());
            const lines = raw.split("\n");

            if (result.exitCode === 0) {
              // Check for Lerna/Nx summary (monorepo run)
              const lernaMatch = raw.match(
                /Successfully ran target test for (\d+) projects/,
              );

              if (lernaMatch) {
                // Aggregate all individual test results across projects
                let totalTests = 0;
                let totalSuites = 0;
                for (const line of lines) {
                  const tm = line.match(/Tests:\s+(\d+) passed,\s*(\d+) total/);
                  if (tm) totalTests += parseInt(tm[2]);
                  const sm = line.match(
                    /Test Suites:\s+(\d+) passed,\s*(\d+) total/,
                  );
                  if (sm) totalSuites += parseInt(sm[2]);
                }
                const cached = raw.match(/(\d+) out of \d+ tasks/);
                const cacheNote = cached ? ` (${cached[1]} cached)` : "";
                return `Tests PASSED. ${lernaMatch[1]} projects${cacheNote}. Tests: ${totalTests} passed, ${totalTests} total. Test Suites: ${totalSuites} passed, ${totalSuites} total.`;
              }

              // Single package run
              const testLine = lines.find((l) => /Tests:\s+\d+/.test(l));
              const suiteLine = lines.find((l) => /Test Suites:\s+\d+/.test(l));
              const timeLine = lines.find((l) => /Time:\s+/.test(l));

              if (testLine && suiteLine) {
                const parts = [
                  "Tests PASSED.",
                  testLine.trim(),
                  suiteLine.trim(),
                ];
                if (timeLine) parts.push(timeLine.trim());
                return parts.join(" ");
              }

              return `Tests passed (exit code: 0). ${lines.length} lines of output.`;
            }

            // Failure — detailed output
            // For monorepo: find last (most relevant) summary lines
            const testLines = lines.filter((l) => /Tests:\s+\d+/.test(l));
            const suiteLines = lines.filter((l) =>
              /Test Suites:\s+\d+/.test(l),
            );
            const summary = testLines[testLines.length - 1];
            const suiteSummary = suiteLines[suiteLines.length - 1];
            const failedSuites = lines.filter(
              (l) =>
                l.includes("FAIL ") &&
                (l.includes("packages/") || l.includes("apps/")),
            );

            const failureBlocks: string[] = [];
            let inBlock = false;
            for (const line of lines) {
              if (line.match(/^\s*●\s/)) {
                inBlock = true;
                failureBlocks.push(line);
              } else if (inBlock) {
                if (
                  line.trim() === "" &&
                  failureBlocks.length > 0 &&
                  !failureBlocks[failureBlocks.length - 1]?.trim()
                ) {
                  inBlock = false;
                } else {
                  failureBlocks.push(line);
                }
              }
            }

            const output: string[] = [
              `Tests FAILED (exit code: ${result.exitCode}).`,
            ];
            if (summary) output.push(summary.trim());
            if (suiteSummary) output.push(suiteSummary.trim());
            output.push("");

            if (failedSuites.length > 0) {
              output.push("Failed suites:");
              failedSuites.forEach((s) => output.push(`  ${s.trim()}`));
              output.push("");
            }

            if (failureBlocks.length > 0) {
              output.push("Failure details:");
              output.push(...failureBlocks.slice(0, 200));
            }

            return output.join("\n");
          } catch (e: any) {
            return `Test execution error: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // BUILD STATUS
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "build-status": tool({
        description:
          "Listen to Azure DevOps build status for the current or specified branch. " +
          "Watches 2 critical builds (blocking) and 1 non-blocking build (errors only). " +
          "Reads AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT from environment if not provided. " +
          "Requires the Azure CLI (az) with the devops extension installed and authenticated.",
        args: {
          organization: tool.schema.optional(tool.schema.string()),
          project: tool.schema.optional(tool.schema.string()),
          branch: tool.schema.optional(tool.schema.string()),
          watch: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          // Auto-detect org/project from git remote
          let org = args.organization || process.env.AZURE_DEVOPS_ORG || "";
          let project = args.project || process.env.AZURE_DEVOPS_PROJECT || "";

          if (!org || !project) {
            try {
              const remote =
                await $`cd ${root} && git remote get-url origin 2>/dev/null`.quiet();
              const url = remote.stdout.toString().trim();
              // ssh: git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO
              const sshMatch = url.match(
                /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)/,
              );
              // https: https://dev.azure.com/ORG/PROJECT/_git/REPO
              const httpsMatch = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)/);
              const match = sshMatch || httpsMatch;
              if (match) {
                org = org || `https://dev.azure.com/${match[1]}`;
                project = project || match[2];
              }
            } catch {
              // ignore
            }
          }

          if (!org || !project) {
            return "Could not determine Azure DevOps organization/project. Provide them as arguments or set AZURE_DEVOPS_ORG/AZURE_DEVOPS_PROJECT env vars.";
          }

          // Ensure org is a full URL
          if (!org.startsWith("http")) {
            org = `https://dev.azure.com/${org}`;
          }

          // Get branch
          let branch = args.branch || "";
          if (!branch) {
            try {
              const br =
                await $`cd ${root} && git rev-parse --abbrev-ref HEAD`.quiet();
              branch = br.stdout.toString().trim();
            } catch {
              branch = "main";
            }
          }

          const fetchBuilds = async () => {
            const result =
              await $`az pipelines runs list --org ${org} --project ${project} --branch ${branch} --top 3 --output json 2>&1`
                .nothrow()
                .quiet();
            const output = result.stdout.toString();

            if (result.exitCode !== 0) {
              return `Azure CLI error (exit ${result.exitCode}):\n${output}`;
            }

            try {
              const runs = JSON.parse(output);
              if (!Array.isArray(runs) || runs.length === 0) {
                return `No builds found for branch "${branch}".`;
              }

              const statusIcon = (s: string) => {
                switch (s?.toLowerCase()) {
                  case "succeeded":
                    return "[OK]";
                  case "failed":
                    return "[FAIL]";
                  case "inprogress":
                  case "notstarted":
                    return "[RUNNING]";
                  case "canceled":
                  case "cancelled":
                    return "[CANCELLED]";
                  default:
                    return `[${s?.toUpperCase() || "UNKNOWN"}]`;
                }
              };

              const lines: string[] = [
                `Build status for "${branch}" (org: ${org}, project: ${project}):`,
                "",
              ];

              runs.forEach((run: any, i: number) => {
                const blocking = i < 2 ? "(critical)" : "(non-blocking)";
                const name =
                  run.definition?.name || run.pipeline?.name || "Unknown";
                const status = run.result || run.status || "unknown";
                const id = run.id || "?";
                const url = run._links?.web?.href || "";
                lines.push(`${statusIcon(status)} #${id} ${name} ${blocking}`);
                lines.push(`   Status: ${status}`);
                if (url) lines.push(`   URL: ${url}`);
                lines.push("");
              });

              return lines.join("\n");
            } catch {
              return `Failed to parse Azure CLI output:\n${output.slice(0, 2000)}`;
            }
          };

          if (args.watch) {
            // Use PTY for watch mode - poll every 30s
            const existing = manager.findByTitle("Build Status Watch");
            if (existing) manager.kill(existing.id);

            // For watch mode, spawn a bash script that polls
            const session = manager.spawn({
              command: "bash",
              args: [
                "-c",
                `while true; do echo "=== Build check at $(date) ==="; az pipelines runs list --org "${org}" --project "${project}" --branch "${branch}" --top 3 --output json 2>&1 | bun -e "const runs=JSON.parse(await Bun.stdin.text()); runs.forEach((r,i)=>{const b=i<2?'(critical)':'(non-blocking)';const s=r.result||r.status||'unknown';console.log(s.toUpperCase()+' #'+r.id+' '+(r.definition?.name||'Unknown')+' '+b)})"; echo "---"; sleep 30; done`,
              ],
              cwd: root,
              title: "Build Status Watch",
            });

            await new Promise((r) => setTimeout(r, 5000));
            const lines = session.buffer.slice(-20).map(stripAnsi).join("\n");

            return [
              "Build status watch started (polling every 30s).",
              `Session ID: ${session.id}`,
              `PID: ${session.pid}`,
              "",
              "Recent output:",
              lines || "(fetching first status...)",
              "",
              "Use server-logs to check latest build status.",
            ].join("\n");
          }

          // One-shot status check
          return await fetchBuilds();
        },
      }),
    },
  };
};

export default TensorTools;
