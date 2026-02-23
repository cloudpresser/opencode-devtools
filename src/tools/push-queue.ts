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
      const schedMatch = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s/);
      // Extract args from: <schedule> <script> <branch> <remote> <repo> >> ...
      const argsMatch = line.match(
        /push-queue\.sh\s+(\S+)\s+(\S+)\s+(\S+)\s+>>/,
      );

      return {
        branch: branchMatch?.[1] ?? "unknown",
        remote: argsMatch?.[2] ?? "origin",
        repo: argsMatch?.[3] ?? "",
        schedule: schedMatch?.[1] ?? "?",
        raw: line,
      };
    });
  } catch {
    return [];
  }
};

// ─── Scheduling Logic ─────────────────────────────────────────────────────────

/** Random integer in [min, max] inclusive. */
const randBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Given a starting Date, advance to the next business-hour slot.
 * If already within business hours, return as-is.
 */
function nextBusinessSlot(
  from: Date,
  startHour: number,
  endHour: number,
  days: number[],
): Date {
  const d = new Date(from);

  // Advance to next business day if current day is not a business day
  while (!days.includes(d.getDay())) {
    d.setDate(d.getDate() + 1);
    d.setHours(startHour, randBetween(0, 14), 0, 0);
  }

  // If before business hours on a business day, jump to start
  if (d.getHours() < startHour) {
    d.setHours(startHour, randBetween(0, 14), 0, 0);
  }

  // If past business hours, advance to next business day
  if (d.getHours() >= endHour) {
    d.setDate(d.getDate() + 1);
    d.setHours(startHour, randBetween(0, 14), 0, 0);
    // May have landed on a weekend
    while (!days.includes(d.getDay())) {
      d.setDate(d.getDate() + 1);
    }
  }

  return d;
}

/**
 * Compute a schedule of N timestamps during business hours, spaced
 * randomly between minSpacing and maxSpacing minutes apart.
 *
 * @param startAfter - Schedule commits after this time
 * @param count - Number of slots to generate
 */
function computeSchedule(
  startAfter: Date,
  count: number,
  config: DevToolsConfig["pushQueue"],
): Date[] {
  const {
    businessHoursStart: startHour,
    businessHoursEnd: endHour,
    businessDays: days,
    minSpacing,
    maxSpacing,
  } = config;

  const slots: Date[] = [];
  let cursor = nextBusinessSlot(startAfter, startHour, endHour, days);

  for (let i = 0; i < count; i++) {
    slots.push(new Date(cursor));

    // Advance by random spacing
    const gap = randBetween(minSpacing, maxSpacing);
    cursor = new Date(cursor.getTime() + gap * 60_000);

    // Ensure we're still in business hours; if not, roll to next day
    cursor = nextBusinessSlot(cursor, startHour, endHour, days);
  }

  return slots;
}

/**
 * Scan all active queued branches to find the latest scheduled author date.
 * This ensures new queued branches don't overlap with existing schedules.
 */
async function getLatestScheduledDate(
  root: string,
  $: any,
): Promise<Date | null> {
  const jobs = await parseCronJobs($);
  let latest: Date | null = null;

  for (const job of jobs) {
    try {
      const remote = job.remote;
      const remoteTip = (
        await $`git -C ${root} rev-parse ${remote}/${job.branch} 2>/dev/null`.text()
      ).trim();
      const localTip = (
        await $`git -C ${root} rev-parse ${job.branch} 2>/dev/null`.text()
      ).trim();

      if (remoteTip !== localTip) {
        const lastDate = (
          await $`git -C ${root} log --format='%aI' ${remoteTip}..${job.branch} | tail -1`.text()
        ).trim();
        if (lastDate) {
          const d = new Date(lastDate);
          if (!latest || d > latest) latest = d;
        }
      }
    } catch {
      // Skip branches we can't inspect
    }
  }

  return latest;
}

/**
 * Format a Date as an ISO string in local time (for git author dates).
 * E.g. "2026-02-23T09:32:00-05:00"
 */
function toLocalISOString(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOff = Math.abs(offset);
  const oh = pad(Math.floor(absOff / 60));
  const om = pad(absOff % 60);

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

// ─── push-queue-schedule ──────────────────────────────────────────────────────

export function createPushQueueScheduleTool(
  config: DevToolsConfig,
  root: string,
  $: any,
) {
  return [
    "push-queue-schedule",
    tool({
      description:
        "Queue unpushed commits on a branch to be trickle-pushed during business hours " +
        "(Mon–Fri 8am–5pm by default). Each commit's author date is rewritten to a " +
        "random time within business hours, spaced 25–45 minutes apart, so pushes " +
        "appear as natural work activity. A lightweight cron job then pushes each " +
        "commit once its author date arrives. The cron self-removes when done.\n\n" +
        "USE THIS when the user says things like 'queue my changes', 'queue this commit', " +
        "'schedule this push', 'trickle push', or asks to push during business hours. " +
        "The tool automatically rewrites author dates — the user does NOT need to set " +
        "dates manually.\n\n" +
        "If there are already queued commits on other branches, new commits are " +
        "scheduled after the last existing slot to avoid suspicious clustering.",
      args: {
        branch: tool.schema.string(
          "Branch name to queue (e.g. 'feature/my-thing'). Defaults to current branch if omitted.",
        ),
        remote: tool.schema.optional(
          tool.schema.string("Git remote name (default: 'origin')"),
        ),
      },
      async execute(args) {
        const pqConfig = config.pushQueue;
        const remote = args.remote ?? pqConfig.defaultRemote;
        const cronInterval = pqConfig.cronInterval;
        const scriptPath = getScriptPath();

        if (!fs.existsSync(scriptPath)) {
          return `Error: push-queue.sh not found at ${scriptPath}`;
        }

        // Resolve branch — use provided or detect current
        let branch = args.branch;
        if (!branch) {
          branch = (
            await $`git -C ${root} rev-parse --abbrev-ref HEAD`.text()
          ).trim();
        }

        // Make sure script is executable
        await $`chmod +x ${scriptPath}`;

        // Check if job already exists for this branch
        const existing = await parseCronJobs($);
        const alreadyExists = existing.some((j: any) => j.branch === branch);
        if (alreadyExists) {
          return (
            `A push-queue job for branch '${branch}' already exists.\n` +
            `Use push-queue-jobs to check its status, or remove it with:\n` +
            `  crontab -l | grep -v 'push-queue:${branch}' | crontab -`
          );
        }

        // Determine unpushed commits
        let remoteTip = "";
        try {
          remoteTip = (
            await $`git -C ${root} rev-parse ${remote}/${branch} 2>/dev/null`.text()
          ).trim();
        } catch {
          // Branch may not exist on remote yet — all commits are unpushed
        }

        let commitLog: string;
        if (remoteTip) {
          commitLog = (
            await $`git -C ${root} log --reverse --format='%H %aI %s' ${remoteTip}..${branch}`.text()
          ).trim();
        } else {
          // Branch not on remote; take all commits not on the default branch
          try {
            commitLog = (
              await $`git -C ${root} log --reverse --format='%H %aI %s' ${remote}/HEAD..${branch}`.text()
            ).trim();
          } catch {
            commitLog = (
              await $`git -C ${root} log --reverse --format='%H %aI %s' ${branch}`.text()
            ).trim();
          }
        }

        if (!commitLog) {
          return `No unpushed commits found on branch '${branch}'.`;
        }

        const commits = commitLog.split("\n").filter(Boolean);
        const count = commits.length;

        // Find the latest already-scheduled date across all branches
        const latestScheduled = await getLatestScheduledDate(root, $);

        // Schedule starts after: the later of NOW or the latest existing scheduled date
        const now = new Date();
        const scheduleAfter =
          latestScheduled && latestScheduled > now ? latestScheduled : now;

        // Add spacing from the last scheduled time
        const startFrom = new Date(
          scheduleAfter.getTime() +
            randBetween(pqConfig.minSpacing, pqConfig.maxSpacing) * 60_000,
        );

        // Compute the schedule
        const schedule = computeSchedule(startFrom, count, pqConfig);

        // Rewrite author dates using git filter-branch
        // Build the date map: SHA -> new ISO date
        const dateMap = new Map<string, string>();
        const commitDetails: string[] = [];
        for (let i = 0; i < count; i++) {
          const sha = commits[i]!.split(" ")[0]!;
          const msg = commits[i]!.split(" ").slice(2).join(" ");
          const newDate = toLocalISOString(schedule[i]!);
          dateMap.set(sha, newDate);
          commitDetails.push(`  ${sha.slice(0, 10)}  ${newDate}  ${msg}`);
        }

        // Use git rebase to rewrite author dates
        // We use GIT_COMMITTER_DATE=author_date to keep them in sync
        const baseRef = remoteTip || `${branch}~${count}`;

        // Build env filter script
        const cases = Array.from(dateMap.entries())
          .map(
            ([sha, date]) =>
              `${sha}) export GIT_AUTHOR_DATE="${date}" GIT_COMMITTER_DATE="${date}" ;;`,
          )
          .join("\n");

        const envFilter = `case $GIT_COMMIT in\n${cases}\nesac`;

        try {
          await $`git -C ${root} filter-branch -f --env-filter ${envFilter} ${baseRef}..${branch}`;
        } catch (e: any) {
          return `Error rewriting author dates: ${e.message}\n\nYou may need to clean up with: git -C ${root} filter-branch --original refs/original`;
        }

        // Set up cron job
        const logFile = `/tmp/git-push-${branch}-$(date +%Y%m%d).log`;
        const cronLine = `*/${cronInterval} * * * * ${scriptPath} ${branch} ${remote} ${root} >> ${logFile} 2>&1 # tensor:${CRON_TAG_PREFIX}${branch}`;

        await $`(crontab -l 2>/dev/null; echo ${cronLine}) | crontab -`;

        const firstDate = toLocalISOString(schedule[0]!);
        const lastDate = toLocalISOString(schedule[schedule.length - 1]!);

        return (
          `Queued ${count} commits on '${branch}' for trickle-push:\n\n` +
          `Schedule: ${firstDate} → ${lastDate}\n` +
          `Spacing:  ${pqConfig.minSpacing}–${pqConfig.maxSpacing} min (random)\n` +
          `Hours:    ${pqConfig.businessHoursStart}:00–${pqConfig.businessHoursEnd}:00, ` +
          `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => pqConfig.businessDays.includes(i)).join("/")}\n` +
          `Cron:     every ${cronInterval} min (polls for ready commits)\n` +
          `Remote:   ${remote}\n\n` +
          `Commits (rewritten author dates):\n` +
          commitDetails.join("\n")
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
        "including queued commit counts, scheduled times, and next push.",
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
            `Remote:   ${job.remote}`,
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
            const remote = job.remote;
            const remoteTip = (
              await $`git -C ${root} rev-parse ${remote}/${job.branch} 2>/dev/null`.text()
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
