import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import path from "node:path";
import fs from "node:fs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SCRIPT_NAME = "push-queue.sh";
const CRON_TAG_PREFIX = "push-queue:";

/** Resolve the embedded push-queue.sh script bundled with this plugin. */
const getScriptPath = () =>
  path.resolve(import.meta.dirname, "../scripts", SCRIPT_NAME);

/** Parse active push-queue cron entries. */
const parseCronJobs = async ($: any) => {
  try {
    const result = await $`crontab -l 2>/dev/null`.text();
    const lines = result
      .split("\n")
      .filter((l: string) => l.includes("push-queue"));

    return lines.map((line: string) => {
      const branchMatch = line.match(/push-queue:(\S+)/);
      const repoMatch = line.match(/>>.*?git-push-/);
      const schedMatch = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s/);

      return {
        branch: branchMatch?.[1] ?? "unknown",
        schedule: schedMatch?.[1] ?? "?",
        raw: line,
      };
    });
  } catch {
    return [];
  }
};

// ─── push-queue-schedule ──────────────────────────────────────────────────────

export function createPushQueueScheduleTool(
  _config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "push-queue-schedule",
    tool({
      description:
        "Schedule a trickle-push cron job for a git branch. " +
        "Commits are pushed only when their author date has passed, " +
        "making the git history appear natural. " +
        "The cron job self-removes once all commits are pushed.",
      args: {
        branch: tool.schema.string("Branch name to push (e.g. 'onboarding')"),
        remote: tool.schema.optional(
          tool.schema.string("Git remote name (default: 'origin')"),
        ),
        interval: tool.schema.optional(
          tool.schema.number("Cron interval in minutes (default: 30)"),
        ),
      },
      async execute(args) {
        const branch = args.branch;
        const remote = args.remote ?? "origin";
        const interval = args.interval ?? 30;
        const scriptPath = getScriptPath();

        if (!fs.existsSync(scriptPath)) {
          return `Error: push-queue.sh not found at ${scriptPath}`;
        }

        // Make sure script is executable
        await $`chmod +x ${scriptPath}`;

        // Check if job already exists for this branch
        const existing = await parseCronJobs($);
        const alreadyExists = existing.some((j: any) => j.branch === branch);
        if (alreadyExists) {
          return `A push-queue job for branch '${branch}' already exists. Remove it first with crontab -e or wait for it to self-remove.`;
        }

        // Get current unpushed commit count for context
        let commitInfo = "";
        try {
          const remoteTip =
            await $`git -C ${root} rev-parse ${remote}/${branch} 2>/dev/null`.text();
          const localTip = await $`git -C ${root} rev-parse ${branch}`.text();

          if (remoteTip.trim() !== localTip.trim()) {
            const count =
              await $`git -C ${root} log --oneline ${remoteTip.trim()}..${branch} | wc -l`.text();
            const nextDate =
              await $`git -C ${root} log --reverse --format='%aI' ${remoteTip.trim()}..${branch} | head -1`.text();
            commitInfo = `\n${count.trim()} commits queued. Next scheduled: ${nextDate.trim()}`;
          }
        } catch {
          // Not critical
        }

        // Build cron line
        const logFile = `/tmp/git-push-${branch}-$(date +%Y%m%d).log`;
        const cronLine = `*/${interval} * * * * ${scriptPath} ${branch} ${remote} ${root} >> ${logFile} 2>&1 # tensor:${CRON_TAG_PREFIX}${branch}`;

        // Add to crontab
        await $`(crontab -l 2>/dev/null; echo ${cronLine}) | crontab -`;

        return (
          `Push-queue scheduled for branch '${branch}':\n` +
          `  Schedule: every ${interval} minutes\n` +
          `  Remote:   ${remote}\n` +
          `  Repo:     ${root}\n` +
          `  Script:   ${scriptPath}\n` +
          `  Log:      /tmp/git-push-${branch}-YYYYMMDD.log` +
          commitInfo
        );
      },
    }),
  ] as const;
}

// ─── push-queue-logs ──────────────────────────────────────────────────────────

export function createPushQueueLogsTool(
  _config: DevToolsConfig,
  _root: string,
  $: any,
) {
  return [
    "push-queue-logs",
    tool({
      description:
        "View logs from a push-queue cron job. " +
        "Shows today's log by default, or a specific date.",
      args: {
        branch: tool.schema.optional(
          tool.schema.string(
            "Branch name (default: first active job's branch)",
          ),
        ),
        date: tool.schema.optional(
          tool.schema.string("Date in YYYYMMDD format (default: today)"),
        ),
        lines: tool.schema.optional(
          tool.schema.number("Number of tail lines to show (default: 50)"),
        ),
      },
      async execute(args) {
        let branch = args.branch;
        const lines = args.lines ?? 50;

        // If no branch specified, find from active jobs
        if (!branch) {
          const jobs = await parseCronJobs($);
          if (jobs.length > 0) {
            branch = jobs[0].branch;
          } else {
            return "No active push-queue jobs found. Specify a branch explicitly.";
          }
        }

        const date = (
          args.date ?? new Date().toISOString().slice(0, 10)
        ).replace(/-/g, "");
        const logPath = `/tmp/git-push-${branch}-${date}.log`;

        if (!fs.existsSync(logPath)) {
          // List available logs
          try {
            const available =
              await $`ls -la /tmp/git-push-${branch}-*.log 2>/dev/null`.text();
            return `No log found at ${logPath}\n\nAvailable logs:\n${available}`;
          } catch {
            return `No log found at ${logPath} and no other logs for branch '${branch}'.`;
          }
        }

        try {
          const content = await $`tail -n ${lines} ${logPath}`.text();
          return `=== ${logPath} (last ${lines} lines) ===\n\n${content}`;
        } catch (e: any) {
          return `Error reading log: ${e.message}`;
        }
      },
    }),
  ] as const;
}

// ─── push-queue-jobs ──────────────────────────────────────────────────────────

export function createPushQueueJobsTool(
  _config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "push-queue-jobs",
    tool({
      description:
        "List active push-queue cron jobs with their status, " +
        "including queued commit counts and next scheduled push time.",
      args: {},
      async execute() {
        const jobs = await parseCronJobs($);

        if (jobs.length === 0) {
          return "No active push-queue cron jobs.";
        }

        const results: string[] = [];

        for (const job of jobs) {
          const lines = [
            `Branch:   ${job.branch}`,
            `Schedule: ${job.schedule}`,
          ];

          // Log info
          const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const logPath = `/tmp/git-push-${job.branch}-${today}.log`;
          if (fs.existsSync(logPath)) {
            try {
              const lastLine = await $`tail -1 ${logPath}`.text();
              lines.push(`Last log: ${lastLine.trim()}`);
            } catch {
              // ignore
            }
          }

          // Commit queue info
          try {
            const remoteTip = (
              await $`git -C ${root} rev-parse origin/${job.branch} 2>/dev/null`.text()
            ).trim();
            const localTip = (
              await $`git -C ${root} rev-parse ${job.branch} 2>/dev/null`.text()
            ).trim();

            if (remoteTip !== localTip) {
              const commits = (
                await $`git -C ${root} log --reverse --format='%h %aI %s' ${remoteTip}..${job.branch}`.text()
              ).trim();
              const commitLines = commits.split("\n").filter(Boolean);
              const now = Date.now();
              lines.push(`Queued:   ${commitLines.length} commits remaining`);
              if (commitLines.length > 0) {
                const firstDate = commitLines[0]!.split(" ")[1]!;
                lines.push(`Next:     ${firstDate}`);
                lines.push("");
                lines.push("Commits:");
                for (const cl of commitLines) {
                  const [sha, date, ...rest] = cl.split(" ");
                  const msg = rest.join(" ");
                  const epoch = new Date(date!).getTime();
                  const status = epoch <= now ? "ready" : "scheduled";
                  lines.push(`  ${sha}  ${date}  [${status}]  ${msg}`);
                }
              }
            } else {
              lines.push("Queued:   0 (fully pushed)");
            }
          } catch {
            lines.push("Queued:   (unable to determine)");
          }

          results.push(lines.join("\n"));
        }

        return results.join("\n\n");
      },
    }),
  ] as const;
}
