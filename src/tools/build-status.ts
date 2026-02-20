import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import type { SessionManager } from "../session-manager";
import { stripAnsi } from "../utils";

export function createBuildStatusTool(
  config: DevToolsConfig,
  manager: SessionManager,
  root: string,
  $: any,
) {
  const cfg = config.buildStatus;

  return ["build-status", tool({
    description:
      "Check CI/CD build status for the current or specified branch. " +
      "Reads organization and project from environment if not provided. " +
      "Requires the appropriate CLI tool installed and authenticated.",
    args: {
      organization: tool.schema.optional(tool.schema.string()),
      project: tool.schema.optional(tool.schema.string()),
      branch: tool.schema.optional(tool.schema.string()),
      watch: tool.schema.optional(tool.schema.boolean()),
    },
    async execute(args) {
      let org = args.organization || process.env.AZURE_DEVOPS_ORG || "";
      let project = args.project || process.env.AZURE_DEVOPS_PROJECT || "";

      if (!org || !project) {
        try {
          const remote =
            await $`cd ${root} && git remote get-url origin 2>/dev/null`.quiet();
          const url = remote.stdout.toString().trim();
          const sshMatch = url.match(
            /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)/,
          );
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
        return "Could not determine organization/project. Provide them as arguments or set appropriate env vars.";
      }

      if (!org.startsWith("http")) {
        org = `https://dev.azure.com/${org}`;
      }

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
        const result =
          await $`${cfg.command} ${[...cfg.args, "--org", org, "--project", project, "--branch", branch, "--top", String(cfg.topBuilds), "--output", "json"]} 2>&1`
            .nothrow()
            .quiet();
        const output = result.stdout.toString();

        if (result.exitCode !== 0) {
          return `CLI error (exit ${result.exitCode}):\n${output}`;
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
          return `Failed to parse CLI output:\n${output.slice(0, 2000)}`;
        }
      };

      if (args.watch) {
        const existing = manager.findByTitle("Build Status Watch");
        if (existing) manager.kill(existing.id);

        const session = manager.spawn({
          command: "bash",
          args: [
            "-c",
            `while true; do echo "=== Build check at $(date) ==="; ${cfg.command} ${cfg.args.join(" ")} --org "${org}" --project "${project}" --branch "${branch}" --top ${cfg.topBuilds} --output json 2>&1 | bun -e "const runs=JSON.parse(await Bun.stdin.text()); runs.forEach((r,i)=>{const b=i<2?'(critical)':'(non-blocking)';const s=r.result||r.status||'unknown';console.log(s.toUpperCase()+' #'+r.id+' '+(r.definition?.name||'Unknown')+' '+b)})"; echo "---"; sleep ${cfg.watchInterval}; done`,
          ],
          cwd: root,
          title: "Build Status Watch",
        });

        await new Promise((r) => setTimeout(r, 5000));
        const lines = session.buffer.slice(-20).map(stripAnsi).join("\n");

        return [
          `Build status watch started (polling every ${cfg.watchInterval}s).`,
          `Session ID: ${session.id}`,
          `PID: ${session.pid}`,
          "",
          "Recent output:",
          lines || "(fetching first status...)",
          "",
          "Use server-logs to check latest build status.",
        ].join("\n");
      }

      return await fetchBuilds();
    },
  })] as const;
}
