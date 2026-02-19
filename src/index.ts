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

const ERROR_START =
  /(?:Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError|AggregateError|error TS\d+|ENOENT|EACCES|ECONNREFUSED|Failed to compile|Build Error|Unhandled Runtime Error|Module not found)/;

const STACK_LINE = /^\s+at\s|^Error:|^\s+\^/;

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
          "This tool cannot directly spawn long-running background processes. " +
          "It returns the exact pty_spawn command you must call next to start the server. " +
          "After calling pty_spawn, store the session ID and use it with server-logs and server-errors tools.",
        args: {
          server: tool.schema.enum(["expo", "nextjs"]),
          port: tool.schema.optional(tool.schema.number()),
        },
        async execute(args) {
          const config = {
            expo: {
              cwd: path.join(root, "apps", "mobile"),
              command: "yarn",
              args: ["dev"],
              title: "Expo Dev Server",
              portFlag: "--port",
            },
            nextjs: {
              cwd: path.join(root, "apps", "next"),
              command: "yarn",
              args: ["dev"],
              title: "Next.js Dev Server",
              portFlag: "-p",
            },
          };

          const cfg = config[args.server];

          // Kill existing session for this server type
          const existing = manager.findByTitle(cfg.title);
          if (existing) {
            manager.kill(existing.id);
          }

          const cmdArgs = [...cfg.args];
          if (args.port) {
            cmdArgs.push(cfg.portFlag, String(args.port));
          }

          const session = manager.spawn({
            command: cfg.command,
            args: cmdArgs,
            cwd: cfg.cwd,
            title: cfg.title,
          });

          // Wait briefly for server to start producing output
          await new Promise((r) => setTimeout(r, 2000));

          const lines = session.buffer.slice(-10).map(stripAnsi).join("\n");

          return [
            `Server started: ${cfg.title}`,
            `Session ID: ${session.id}`,
            `PID: ${session.pid}`,
            `Status: ${session.status}`,
            `Working directory: ${cfg.cwd}`,
            "",
            "Recent output:",
            lines || "(no output yet - server may still be starting)",
            "",
            "Use server-logs and server-errors tools with this session to monitor.",
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
          "Supports regex filtering, pagination (offset + lineCount), and verbose mode.",
        args: {
          server: tool.schema.enum(["expo", "next"]),
          pattern: tool.schema.optional(tool.schema.string()),
          offset: tool.schema.optional(tool.schema.number()),
          lineCount: tool.schema.optional(tool.schema.number()),
          verbose: tool.schema.optional(tool.schema.boolean()),
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

          const limit = args.lineCount ?? 100;
          const offset = args.offset ?? 0;
          const result = manager.readBuffer(session.id, {
            offset,
            limit,
            pattern: args.pattern,
          });

          if (!result) return "Session not found.";

          let lines = result.lines;
          if (!args.verbose) {
            lines = lines.map(stripAnsi).filter((l) => l.trim().length > 0);
          }

          const header = [
            `=== ${titleMap[args.server]} Logs ===`,
            `Session: ${session.id} | Status: ${session.status}`,
            `Lines: ${offset + 1}-${offset + lines.length} of ${result.totalLines}`,
            args.pattern
              ? `Filter: /${args.pattern}/ (${result.matchedLines} matches)`
              : "",
            "---",
          ]
            .filter(Boolean)
            .join("\n");

          const numbered = lines
            .map((l, i) => `${String(offset + i + 1).padStart(5)} | ${l}`)
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
      // SERVER ERRORS
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "server-errors": tool({
        description:
          "Get errors with stack traces from a running Expo or Next.js dev server. " +
          "The dev server must have been started with the dev-server tool. " +
          "Supports four modes: all (every error), list (short summary), " +
          "regex (filter by pattern), or index (single error by index).",
        args: {
          server: tool.schema.enum(["expo", "next"]),
          mode: tool.schema.enum(["all", "list", "regex", "index"]),
          pattern: tool.schema.optional(tool.schema.string()),
          index: tool.schema.optional(tool.schema.number()),
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

          const rawLines = session.buffer.map(stripAnsi);

          // Parse error blocks
          const errors: { header: string; lines: string[] }[] = [];
          let current: { header: string; lines: string[] } | null = null;

          for (const line of rawLines) {
            if (ERROR_START.test(line)) {
              if (current) errors.push(current);
              current = { header: line.trim(), lines: [line] };
            } else if (
              current &&
              (STACK_LINE.test(line) || line.startsWith(" "))
            ) {
              current.lines.push(line);
            } else if (current) {
              // Check if it's a continuation (indented or empty)
              if (line.trim() === "") {
                current.lines.push(line);
              } else {
                errors.push(current);
                current = null;
              }
            }
          }
          if (current) errors.push(current);

          if (errors.length === 0) {
            return `No errors found in ${args.server} server output.`;
          }

          switch (args.mode) {
            case "all":
              return [
                `Found ${errors.length} error(s) in ${args.server} server:`,
                "",
                ...errors.flatMap((e, i) => [
                  `━━━ Error ${i + 1} ━━━`,
                  ...e.lines,
                  "",
                ]),
              ].join("\n");

            case "list":
              return [
                `Found ${errors.length} error(s):`,
                ...errors.map(
                  (e, i) =>
                    `  [${i}] ${e.header.slice(0, 120)}${e.header.length > 120 ? "..." : ""}`,
                ),
              ].join("\n");

            case "regex": {
              if (!args.pattern) return "Pattern is required for regex mode.";
              try {
                const regex = new RegExp(args.pattern, "i");
                const matched = errors.filter(
                  (e) =>
                    regex.test(e.header) || e.lines.some((l) => regex.test(l)),
                );
                if (matched.length === 0)
                  return `No errors matching /${args.pattern}/`;
                return [
                  `${matched.length} error(s) matching /${args.pattern}/:`,
                  "",
                  ...matched.flatMap((e, i) => [
                    `━━━ Error ${i + 1} ━━━`,
                    ...e.lines,
                    "",
                  ]),
                ].join("\n");
              } catch {
                return `Invalid regex: ${args.pattern}`;
              }
            }

            case "index": {
              const idx = args.index ?? 0;
              if (idx < 0 || idx >= errors.length) {
                return `Index ${idx} out of range. ${errors.length} errors available (0-${errors.length - 1}).`;
              }
              return [`Error ${idx}:`, ...errors[idx].lines].join("\n");
            }
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // CHECK TYPES
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "check-types": tool({
        description:
          "Run TypeScript type checking on the monorepo. " +
          "Returns errors found or confirms no errors.",
        args: {
          compact: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const compact = args.compact !== false; // default true
          try {
            const result = await $`cd ${root} && yarn check-types 2>&1`
              .nothrow()
              .quiet();
            const output = result.stdout.toString();
            const exitCode = result.exitCode;

            if (
              exitCode === 0 ||
              output.includes("Done") ||
              output.includes("Successfully ran")
            ) {
              return "Type check passed. No errors found.";
            }

            if (!compact) {
              return output.slice(0, 10_000);
            }

            // Compact: group errors by file
            const errorRegex =
              /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
            const byFile = new Map<string, string[]>();
            let match;
            let count = 0;

            while ((match = errorRegex.exec(output)) !== null) {
              const [, file, row, col, code, msg] = match;
              const key = file.trim();
              if (!byFile.has(key)) byFile.set(key, []);
              byFile.get(key)!.push(`  L${row}:${col} ${code}: ${msg}`);
              count++;
            }

            if (count === 0) {
              // Couldn't parse, return raw
              return output.slice(0, 10_000);
            }

            const lines: string[] = [
              `Found ${count} type error(s) in ${byFile.size} file(s):`,
              "",
            ];
            for (const [file, errs] of byFile) {
              lines.push(
                `${file} (${errs.length} error${errs.length > 1 ? "s" : ""}):`,
              );
              lines.push(...errs);
              lines.push("");
            }

            return lines.join("\n");
          } catch (e: any) {
            return `Type check failed: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // CREATE PR
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "create-pr": tool({
        description:
          "Create a pull request using @cloudpresser/create-pr CLI. " +
          "Uses AI to generate a PR title and description from the diff.",
        args: {
          title: tool.schema.optional(tool.schema.string()),
          body: tool.schema.optional(tool.schema.string()),
          draft: tool.schema.optional(tool.schema.boolean()),
          targetBranch: tool.schema.optional(tool.schema.string()),
          baseBranch: tool.schema.optional(tool.schema.string()),
        },
        async execute(args) {
          const cmdArgs: string[] = [];

          // Let the CLI read org/project/repo from .cloudpresser files.
          // Only pass args that the user explicitly provided.
          if (args.title) cmdArgs.push("--title", args.title);
          if (args.body) cmdArgs.push("--description", args.body);
          if (args.draft) cmdArgs.push("--draft");
          const target = args.targetBranch || args.baseBranch;
          if (target) cmdArgs.push("--targetBranch", target);

          // Use PTY to handle interactive prompts automatically
          try {
            const output = await new Promise<string>((resolve, reject) => {
              const timeout = setTimeout(() => {
                try {
                  term.kill();
                } catch {}
                reject(new Error("timeout"));
              }, 120_000);

              let buffer = "";
              const term = new Terminal(
                "bunx",
                ["@cloudpresser/create-pr", ...cmdArgs],
                {
                  cwd: root,
                  name: "xterm-256color",
                  env: process.env as Record<string, string>,
                },
              );

              term.onData((data: string) => {
                buffer += data;
                // Auto-answer interactive prompts:
                // "Do you want to edit the pull request title? (y/n)"  -> n
                // "Do you want to edit the pull request description? (y/n)" -> n
                // "Do you want to create this pull request? (y/n)" -> y
                if (
                  /edit the pull request (title|description)\?\s*\(y\/n\)\s*$/i.test(
                    buffer,
                  )
                ) {
                  term.write("n\n");
                  buffer = "";
                } else if (
                  /create this pull request\?\s*\(y\/n\)\s*$/i.test(buffer)
                ) {
                  term.write("y\n");
                  buffer = "";
                }
              });

              term.onExit(({ exitCode }: { exitCode: number }) => {
                clearTimeout(timeout);
                if (exitCode === 0) {
                  resolve(buffer);
                } else {
                  resolve(buffer); // Still return output for error diagnosis
                }
              });
            });

            // Strip ANSI escape codes for clean output
            const clean = output.replace(
              /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g,
              "",
            );

            const prUrlMatch = clean.match(
              /https:\/\/dev\.azure\.com\/[^\s]+\/pullrequest\/\d+/,
            );

            if (prUrlMatch) {
              return `PR created successfully!\nURL: ${prUrlMatch[0]}\n\n${clean}`;
            }

            return (
              clean || "PR creation completed (no URL detected in output)."
            );
          } catch (e: any) {
            if (e.message?.includes("timeout")) {
              return "PR creation timed out after 120s. The CLI may be stuck.";
            }
            return `PR creation error: ${e.message}`;
          }
        },
      }),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // RUN TESTS
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      "run-tests": tool({
        description:
          "Run tests using yarn test. For watch mode, starts a background PTY session. " +
          "For non-watch mode, runs tests and returns results with pass/fail summary.",
        args: {
          package: tool.schema.optional(tool.schema.string()),
          watch: tool.schema.optional(tool.schema.boolean()),
          coverage: tool.schema.optional(tool.schema.boolean()),
        },
        async execute(args) {
          const yarnArgs = ["test"];
          if (args.package) yarnArgs.push(args.package);
          if (args.coverage) yarnArgs.push("--coverage");

          if (args.watch) {
            // Use PTY for watch mode (long-running)
            const existing = manager.findByTitle("Test Watch");
            if (existing) manager.kill(existing.id);

            const watchArgs = [...yarnArgs, "--", "--watch"];
            const session = manager.spawn({
              command: "yarn",
              args: watchArgs,
              cwd: root,
              title: "Test Watch",
            });

            await new Promise((r) => setTimeout(r, 3000));
            const lines = session.buffer.slice(-20).map(stripAnsi).join("\n");

            return [
              "Test watch mode started.",
              `Session ID: ${session.id}`,
              `PID: ${session.pid}`,
              "",
              "Recent output:",
              lines || "(starting...)",
              "",
              "Use server-logs to monitor test output.",
            ].join("\n");
          }

          // Non-watch: run to completion
          try {
            const result = await $`cd ${root} && yarn ${yarnArgs} 2>&1`
              .nothrow()
              .quiet();
            const output = result.stdout.toString();

            // Extract summary
            const summaryLines = output
              .split("\n")
              .filter(
                (l) =>
                  /Tests?:/.test(l) ||
                  /Suites?:/.test(l) ||
                  /Snapshots?:/.test(l) ||
                  /Time:/.test(l) ||
                  /PASS|FAIL/.test(l),
              )
              .map(stripAnsi);

            const summary =
              summaryLines.length > 0
                ? summaryLines.join("\n")
                : output.slice(-2000);

            const status = result.exitCode === 0 ? "PASSED" : "FAILED";

            return [
              `Tests ${status} (exit code: ${result.exitCode})`,
              "",
              summary,
            ].join("\n");
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
