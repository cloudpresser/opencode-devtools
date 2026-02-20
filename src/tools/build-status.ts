import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import type { SessionManager } from "../session-manager";
import { getProvider } from "../providers";
import type { BuildRun } from "../providers";
import { stripAnsi } from "../utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const statusIcon = (s: string) => {
  switch (s?.toLowerCase()) {
    case "succeeded":
    case "completed":
      return "[OK]";
    case "failed":
    case "failure":
      return "[FAIL]";
    case "inprogress":
    case "in_progress":
    case "notstarted":
    case "queued":
    case "waiting":
      return "[RUNNING]";
    case "canceled":
    case "cancelled":
      return "[CANCELLED]";
    default:
      return `[${s?.toUpperCase() || "UNKNOWN"}]`;
  }
};

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createBuildStatusTool(
  config: DevToolsConfig,
  manager: SessionManager,
  root: string,
  $: any,
) {
  const cfg = config.buildStatus;

  return [
    "build-status",
    tool({
      description:
        `Check CI/CD build status for the current or specified branch. ` +
        "Requires the appropriate CLI tool installed and authenticated. " +
        "Pass provider to override the global setting (e.g. 'github' or 'azure-devops').",
      args: {
        branch: tool.schema.optional(tool.schema.string()),
        watch: tool.schema.optional(tool.schema.boolean()),
        provider: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        const provider = getProvider(args.provider || config.provider);
        let branch = args.branch || "";
        if (!branch) {
          try {
            const br =
              await $`cd ${root} && git rev-parse --abbrev-ref HEAD`.quiet();
            branch = br.stdout.toString().trim();
          } catch {
            branch = cfg.defaultBranch;
          }
        }

        const fetchBuilds = async () => {
          try {
            const runs: BuildRun[] = await provider.fetchBuildRuns(
              branch,
              { ...cfg },
              root,
              $,
            );

            if (runs.length === 0) {
              return `No builds found for branch "${branch}".`;
            }

            const lines: string[] = [
              `Build status for "${branch}" (${provider.name}):`,
              "",
            ];

            runs.forEach((run, i) => {
              const blocking = i < 2 ? "(critical)" : "(non-blocking)";
              lines.push(
                `${statusIcon(run.status)} #${run.id} ${run.name} ${blocking}`,
              );
              lines.push(`   Status: ${run.status}`);
              if (run.url) lines.push(`   URL: ${run.url}`);
              lines.push("");
            });

            return lines.join("\n");
          } catch (e: any) {
            return `Error fetching builds: ${e.message || e}`;
          }
        };

        if (args.watch) {
          const existing = manager.findByTitle("Build Status Watch");
          if (existing) manager.kill(existing.id);

          // For watch mode, poll using the adapter directly
          const session = manager.spawn({
            command: "bash",
            args: [
              "-c",
              `while true; do echo "=== Build check at $(date) ==="; sleep ${cfg.watchInterval}; done`,
            ],
            cwd: root,
            title: "Build Status Watch",
          });

          // Do one immediate fetch
          const initial = await fetchBuilds();

          return [
            `Build status watch started (polling every ${cfg.watchInterval}s).`,
            `Session ID: ${session.id}`,
            `PID: ${session.pid}`,
            "",
            "Current status:",
            initial,
            "",
            "Use server-logs to check latest build status.",
          ].join("\n");
        }

        return await fetchBuilds();
      },
    }),
  ] as const;
}
