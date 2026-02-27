import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { getProvider } from "../providers";
import type { PrResult, PrReviewer, PrPolicy, PrWorkItem } from "../providers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const statusIcon = (status: string): string => {
  switch (status.toLowerCase()) {
    case "approved":
    case "succeeded":
      return "[OK]";
    case "rejected":
    case "failed":
      return "[FAIL]";
    case "running":
    case "inprogress":
      return "[RUNNING]";
    case "queued":
    case "notstarted":
      return "[QUEUED]";
    case "broken":
      return "[BROKEN]";
    default:
      return `[${status.toUpperCase()}]`;
  }
};

const formatField = (label: string, value: any): string => {
  if (value === undefined || value === null || value === "") return "";
  const strVal =
    typeof value === "object"
      ? value.displayName || value.uniqueName || JSON.stringify(value)
      : String(value);
  return `**${label}:** ${strVal}`;
};

const formatDuration = (startDate: string, endDate?: string): string => {
  const start = new Date(startDate).getTime();
  const end = endDate ? new Date(endDate).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
};

// ─── Formatting ───────────────────────────────────────────────────────────────

const VOTE_LABELS: Record<string, string> = {
  approved: "Approved",
  "approved-with-suggestions": "Approved with suggestions",
  "no-vote": "No vote",
  "waiting-for-author": "Waiting for author",
  rejected: "Rejected",
  // Azure DevOps numeric votes (mapped by adapter)
  "10": "Approved",
  "5": "Approved with suggestions",
  "0": "No vote",
  "-5": "Waiting for author",
  "-10": "Rejected",
};

const formatReviewer = (r: PrReviewer): string => {
  const vote = VOTE_LABELS[r.vote] || r.vote;
  const required = r.isRequired ? " (required)" : "";
  return `- ${r.name}: ${vote}${required}`;
};

interface ClassifiedPolicies {
  waitFor: PrPolicy[];
  noWait: PrPolicy[];
  other: PrPolicy[];
}

const classifyPolicies = (
  policies: PrPolicy[],
  cfg: DevToolsConfig["getPr"],
): ClassifiedPolicies => {
  const builds = policies.filter(
    (p) => p.type === "Build" || p.type === "build" || p.type === "check",
  );
  const nonBuilds = policies.filter(
    (p) => p.type !== "Build" && p.type !== "build" && p.type !== "check",
  );

  const waitFor: PrPolicy[] = [];
  const noWait: PrPolicy[] = [];

  for (const build of builds) {
    const name = build.name ?? "";
    const isNoWait = cfg.noWaitBuilds.some((pattern) =>
      name.toLowerCase().includes(pattern.toLowerCase()),
    );
    if (isNoWait) {
      noWait.push(build);
    } else {
      waitFor.push(build);
    }
  }

  return { waitFor, noWait, other: nonBuilds };
};

const formatPolicyLine = (p: PrPolicy): string => {
  const icon = statusIcon(p.status);
  const name = p.name ?? "Unknown";
  const duration =
    p.startedAt && p.status !== "queued"
      ? `(${formatDuration(p.startedAt, p.completedAt)})`
      : "";
  const buildRef = p.buildId ? `Build #${p.buildId}` : "";
  return `${icon.padEnd(10)} ${name.padEnd(45)} ${buildRef}  ${duration}`.trimEnd();
};

export const formatPrOutput = (
  pr: PrResult,
  cfg: DevToolsConfig["getPr"],
): string => {
  const lines: string[] = [];

  // Header
  lines.push(`## PR #${pr.id}: ${pr.title || "(untitled)"}`);
  lines.push("");

  // Metadata
  const fields = [
    formatField("Status", pr.status),
    formatField("Draft", pr.isDraft ? "Yes" : "No"),
    formatField("Source", pr.sourceBranch),
    formatField("Target", pr.targetBranch),
    formatField("Merge Status", pr.mergeStatus),
    formatField("Created By", pr.createdBy),
    formatField("Created", pr.createdDate),
    formatField("Repository", pr.repository),
  ].filter(Boolean);

  if (pr.labels?.length) {
    fields.push(formatField("Labels", pr.labels.join(", ")));
  }

  lines.push(fields.join("\n"));
  lines.push("");

  // Description
  lines.push("### Description");
  lines.push(pr.description || "(none)");
  lines.push("");

  // Reviewers
  if (pr.reviewers?.length) {
    lines.push("### Reviewers");
    for (const r of pr.reviewers) lines.push(formatReviewer(r));
    lines.push("");
  }

  // Policies / Checks
  if (pr.policies?.length) {
    const classified = classifyPolicies(pr.policies, cfg);

    if (classified.waitFor.length || classified.noWait.length) {
      lines.push("### Build Policies");
      for (const build of [...classified.waitFor, ...classified.noWait]) {
        const isNoWait = classified.noWait.includes(build);
        const suffix = isNoWait ? " (no-wait)" : "";
        lines.push(formatPolicyLine(build) + suffix);
      }
      lines.push("");
    }

    if (classified.other.length) {
      lines.push("### Other Policies");
      for (const p of classified.other) {
        const icon = statusIcon(p.status);
        const blocking = p.isBlocking ? "" : " (optional)";
        lines.push(`${icon.padEnd(10)} ${p.name}${blocking}`);
      }
      lines.push("");
    }
  }

  // Linked Work Items
  if (pr.workItems?.length) {
    lines.push("### Linked Work Items");
    for (const wi of pr.workItems) {
      const typeTag = wi.type ? `[${wi.type}]` : "";
      const stateTag = wi.state ? `(${wi.state})` : "";
      lines.push(`- #${wi.id} ${typeTag} ${wi.title} ${stateTag}`.trimEnd());
    }
    lines.push("");
  }

  return lines.join("\n");
};

// ─── Watch Mode ───────────────────────────────────────────────────────────────

const watchBuilds = async (
  ref: string,
  config: DevToolsConfig,
  root: string,
  $: any,
): Promise<string> => {
  const cfg = config.getPr;
  const provider = getProvider(config.provider);
  const interval = cfg.watchInterval;
  const timeout = cfg.watchTimeout;
  const startTime = Date.now();
  let pollCount = 0;

  while (true) {
    pollCount++;
    const elapsed = (Date.now() - startTime) / 1000;

    const pr = await provider.fetchPr(ref, config, root, $);
    const classified = classifyPolicies(pr.policies || [], cfg);

    if (elapsed >= timeout) {
      const lines = [
        `## PR #${pr.id} Build Status — TIMEOUT`,
        "",
        `Timed out after ${formatDuration(new Date(startTime).toISOString())} (${pollCount} polls)`,
        "",
      ];
      appendPolicySummary(lines, classified);
      return lines.join("\n");
    }

    // Check completion conditions
    const allApproved = classified.waitFor.every(
      (b) => b.status.toLowerCase() === "approved" || b.status.toLowerCase() === "succeeded",
    );
    const anyFailed = classified.waitFor.some(
      (b) => b.status.toLowerCase() === "rejected" || b.status.toLowerCase() === "failed",
    );

    if (allApproved && classified.waitFor.length > 0) {
      const totalTime = formatDuration(new Date(startTime).toISOString());
      const passed = classified.waitFor.length;
      const lines = [
        `## PR #${pr.id} Build Status — SUCCESS`,
        "",
        `### Builds (${passed}/${passed} passed)`,
      ];
      for (const b of classified.waitFor) lines.push(formatPolicyLine(b));
      lines.push("");
      appendNoWaitAndOther(lines, classified);
      lines.push(`Completed in ${totalTime} (${pollCount} polls)`);
      return lines.join("\n");
    }

    if (anyFailed) {
      const failed = classified.waitFor.filter(
        (b) => b.status.toLowerCase() === "rejected" || b.status.toLowerCase() === "failed",
      );
      const passed = classified.waitFor.filter(
        (b) => b.status.toLowerCase() === "approved" || b.status.toLowerCase() === "succeeded",
      );
      const total = classified.waitFor.length;
      const lines = [
        `## PR #${pr.id} Build Status — FAILED`,
        "",
        `### Builds (${passed.length}/${total} passed, ${failed.length} FAILED)`,
      ];
      for (const b of classified.waitFor) lines.push(formatPolicyLine(b));
      lines.push("");
      appendNoWaitAndOther(lines, classified);
      const totalTime = formatDuration(new Date(startTime).toISOString());
      lines.push(`Failed after ${totalTime} (${pollCount} polls)`);
      return lines.join("\n");
    }

    await Bun.sleep(interval * 1000);
  }
};

const appendPolicySummary = (
  lines: string[],
  classified: ClassifiedPolicies,
): void => {
  if (classified.waitFor.length) {
    lines.push("### Builds");
    for (const b of classified.waitFor) lines.push(formatPolicyLine(b));
    lines.push("");
  }
  appendNoWaitAndOther(lines, classified);
};

const appendNoWaitAndOther = (
  lines: string[],
  classified: ClassifiedPolicies,
): void => {
  if (classified.noWait.length) {
    lines.push("### No-Wait Builds (not waited on — involves manual QA)");
    for (const b of classified.noWait) lines.push(formatPolicyLine(b));
    lines.push("");
  }
  if (classified.other.length) {
    lines.push("### Other Policies");
    for (const p of classified.other) {
      lines.push(
        `${statusIcon(p.status).padEnd(10)} ${p.name}`,
      );
    }
    lines.push("");
  }
};

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createGetPrTool(config: DevToolsConfig, root: string, $: any) {
  return [
    "get-pr",
    tool({
      description:
        `Fetch pull request metadata (description, reviewers, build policies, ` +
        `linked work items). Use watch=true to block until builds complete or fail. ` +
        `Accepts a PR ID number. ` +
        `Pass provider to override the global setting (e.g. 'github' or 'azure-devops').`,
      args: {
        id: tool.schema.string(),
        watch: tool.schema.optional(tool.schema.boolean()),
        provider: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        const effectiveConfig = args.provider
          ? { ...config, provider: args.provider }
          : config;

        if (args.watch) {
          try {
            return await watchBuilds(args.id, effectiveConfig, root, $);
          } catch (e: any) {
            return `Watch mode error: ${e.message || e}`;
          }
        }

        try {
          const provider = getProvider(effectiveConfig.provider);
          const pr = await provider.fetchPr(args.id, effectiveConfig, root, $);
          return formatPrOutput(pr, effectiveConfig.getPr);
        } catch (e: any) {
          return `Error fetching PR #${args.id}: ${e.message || e}`;
        }
      },
    }),
  ] as const;
}
