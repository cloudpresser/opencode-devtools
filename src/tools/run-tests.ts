import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import type { SessionManager } from "../session-manager";
import { stripAnsi } from "../utils";

export function createRunTestsTool(
  config: DevToolsConfig,
  manager: SessionManager,
  root: string,
  $: any,
) {
  const cfg = config.runTests;

  return ["run-tests", tool({
    description:
      "Run the project test suite. " +
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

        const cmdArgs = [...cfg.args];
        if (args.package) cmdArgs.push(args.package);
        cmdArgs.push("--", "--watch");

        const session = manager.spawn({
          command: cfg.command,
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

      const cmdArgs = [...cfg.args];
      if (args.package) cmdArgs.push(args.package);
      if (args.coverage) cmdArgs.push("--", "--coverage");

      try {
        const result =
          await $`cd ${root} && ${cfg.command} ${cmdArgs} 2>&1`.nothrow().quiet();
        const raw = stripAnsi(result.stdout.toString());
        const lines = raw.split("\n");

        if (result.exitCode === 0) {
          const lernaMatch = raw.match(
            /Successfully ran target test for (\d+) projects/,
          );

          if (lernaMatch) {
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
  })] as const;
}
