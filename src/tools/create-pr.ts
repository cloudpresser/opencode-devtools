import { tool } from "@opencode-ai/plugin";
import { Terminal } from "bun-pty";
import type { DevToolsConfig } from "../config";
import { stripAnsi } from "../utils";

export function createPrTool(config: DevToolsConfig, root: string) {
  const cfg = config.createPr;
  const urlPatternRegex = cfg.urlPattern
    ? new RegExp(cfg.urlPattern)
    : /https?:\/\/[^\s)]+/;

  return [
    "create-pr",
    tool({
      description:
        "Create a pull request using the configured CLI tool. " +
        "Auto-detects org/project/repo from git remote and project config. " +
        "Handles interactive prompts automatically.",
      args: {
        title: tool.schema.optional(tool.schema.string()),
        body: tool.schema.optional(tool.schema.string()),
        draft: tool.schema.optional(tool.schema.boolean()),
        targetBranch: tool.schema.optional(tool.schema.string()),
        baseBranch: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        const cmdArgs = [...cfg.args];
        if (args.title) cmdArgs.push("--title", args.title);
        if (args.body) cmdArgs.push("--description", args.body);
        if (args.draft) cmdArgs.push("--draft");
        const target = args.targetBranch || args.baseBranch;
        if (target) cmdArgs.push("--targetBranch", target);

        return new Promise<string>((resolve) => {
          const terminal = new Terminal(cfg.command, cmdArgs, {
            cwd: root,
            name: "xterm-256color",
            env: process.env as Record<string, string>,
          });

          const output: string[] = [];
          let accumulated = "";
          let answeredTitle = false;
          let answeredDesc = false;
          let answeredCreate = false;
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              terminal.kill();
              const clean = stripAnsi(accumulated)
                .split("\n")
                .filter(
                  (l) =>
                    l.trim().length > 0 &&
                    !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l) &&
                    !l.includes("┌") &&
                    !l.includes("└") &&
                    !l.includes("─"),
                )
                .join("\n");
              resolve(
                `PR creation timed out after ${cfg.timeout}s.\n\n${clean.slice(-2000)}`,
              );
            }
          }, cfg.timeout * 1000);

          terminal.onData((data: string) => {
            output.push(data);
            accumulated += data;
            const buf = stripAnsi(accumulated);

            // Auto-answer interactive prompts (check accumulated buffer)
            if (
              !answeredTitle &&
              /edit the pull request title\?\s*\(y\/n\)/i.test(buf)
            ) {
              answeredTitle = true;
              terminal.write("n\n");
            }
            if (
              !answeredDesc &&
              /edit the pull request description\?\s*\(y\/n\)/i.test(buf)
            ) {
              answeredDesc = true;
              terminal.write("n\n");
            }
            if (
              !answeredCreate &&
              /create (this |the )?pull request\?\s*\(y\/n\)/i.test(buf)
            ) {
              answeredCreate = true;
              terminal.write("y\n");
            }
          });

          terminal.onExit(({ exitCode }: { exitCode: number }) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);

            const fullOutput = output.map(stripAnsi).join("\n");

            // Try to extract PR URL
            const urlMatch = fullOutput.match(urlPatternRegex);

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
  ] as const;
}
