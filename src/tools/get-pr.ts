import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Reviewer {
  displayName: string;
  uniqueName: string;
  vote: number;
  isRequired: boolean;
  hasDeclined: boolean;
}

interface PolicyEvaluation {
  configuration: {
    type: { displayName: string };
    isBlocking: boolean;
    isEnabled: boolean;
    settings?: { buildDefinitionId?: number };
  };
  context?: {
    buildDefinitionName?: string;
    buildId?: number;
    buildIsNotCurrent?: boolean;
  };
  status: string;
  startedDate?: string;
  completedDate?: string;
}

interface WorkItemRef {
  id: string;
  url: string;
}

interface ClassifiedBuilds {
  waitFor: PolicyEvaluation[];
  noWait: PolicyEvaluation[];
  other: PolicyEvaluation[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VOTE_LABELS: Record<number, string> = {
  10: "Approved",
  5: "Approved with suggestions",
  0: "No vote",
  [-5]: "Waiting for author",
  [-10]: "Rejected",
};

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

const stripHtml = (html: string | undefined | null): string => {
  if (!html) return "(none)";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const stripRefPrefix = (ref: string): string =>
  ref.replace(/^refs\/heads\//, "");

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

const classifyBuilds = (
  policies: PolicyEvaluation[],
  config: DevToolsConfig["getPr"],
): ClassifiedBuilds => {
  const builds = policies.filter(
    (p) => p.configuration.type.displayName === "Build",
  );
  const nonBuilds = policies.filter(
    (p) => p.configuration.type.displayName !== "Build",
  );

  const waitFor: PolicyEvaluation[] = [];
  const noWait: PolicyEvaluation[] = [];

  for (const build of builds) {
    const name = build.context?.buildDefinitionName ?? "";
    const isNoWait = config.noWaitBuilds.some((pattern) =>
      name.toLowerCase().includes(pattern.toLowerCase()),
    );
    if (isNoWait) {
      noWait.push(build);
    } else {
      // If it matches waitForBuilds patterns OR doesn't match anything,
      // treat as wait-for (safe fallback)
      waitFor.push(build);
    }
  }

  return { waitFor, noWait, other: nonBuilds };
};

const formatBuildLine = (policy: PolicyEvaluation): string => {
  const name = policy.context?.buildDefinitionName ?? "Unknown Build";
  const buildId = policy.context?.buildId ?? "";
  const icon = statusIcon(policy.status);
  const buildRef = buildId ? `Build #${buildId}` : "";
  const duration =
    policy.startedDate && policy.status !== "queued"
      ? `(${formatDuration(policy.startedDate, policy.completedDate)})`
      : "";
  return `${icon.padEnd(10)} ${name.padEnd(45)} ${buildRef}  ${duration}`.trimEnd();
};

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createGetPrTool(config: DevToolsConfig, root: string, $: any) {
  const cfg = config.getPr;

  // ── Shared: resolve org/project from git remote ──────────────────────
  const resolveOrgProject = async (): Promise<{
    org: string;
    project: string;
  } | null> => {
    let org = process.env.AZURE_DEVOPS_ORG || "";
    let project = process.env.AZURE_DEVOPS_PROJECT || "";

    if (!org || !project) {
      try {
        const remote =
          await $`cd ${root} && git remote get-url origin 2>/dev/null`.quiet();
        const url = remote.stdout.toString().trim();
        const sshMatch = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)/);
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

    if (!org || !project) return null;
    if (!org.startsWith("http")) org = `https://dev.azure.com/${org}`;
    return { org, project };
  };

  // ── Fetch PR metadata ────────────────────────────────────────────────
  const fetchPrMetadata = async (id: number, org: string) => {
    const result =
      await $`az repos pr show --id ${id} --org ${org} --output json`
        .nothrow()
        .quiet();
    const output = result.stdout.toString().trim();
    if (result.exitCode !== 0 || !output) {
      throw new Error(
        `Failed to fetch PR #${id}: ${result.stderr.toString().trim() || "No output"}`,
      );
    }
    return JSON.parse(output);
  };

  // ── Fetch policy evaluations ─────────────────────────────────────────
  const fetchPolicies = async (
    id: number,
    org: string,
  ): Promise<PolicyEvaluation[]> => {
    const result =
      await $`az repos pr policy list --id ${id} --org ${org} --output json`
        .nothrow()
        .quiet();
    const output = result.stdout.toString().trim();
    if (result.exitCode !== 0 || !output) return [];
    try {
      return JSON.parse(output);
    } catch {
      return [];
    }
  };

  // ── Fetch linked work item details ───────────────────────────────────
  const fetchWorkItems = async (
    refs: WorkItemRef[],
    org: string,
  ): Promise<{ id: string; title: string; type: string; state: string }[]> => {
    if (!refs?.length) return [];

    const results = await Promise.all(
      refs.map(async (ref) => {
        try {
          const result =
            await $`az boards work-item show --id ${ref.id} --org ${org} --output json`
              .nothrow()
              .quiet();
          const output = result.stdout.toString().trim();
          if (result.exitCode !== 0 || !output) {
            return { id: ref.id, title: "(fetch failed)", type: "", state: "" };
          }
          const wi = JSON.parse(output);
          const fields = wi.fields || {};
          return {
            id: ref.id,
            title: fields["System.Title"] || "(untitled)",
            type: fields["System.WorkItemType"] || "",
            state: fields["System.State"] || "",
          };
        } catch {
          return { id: ref.id, title: "(error)", type: "", state: "" };
        }
      }),
    );

    return results;
  };

  // ── Format full PR output ────────────────────────────────────────────
  const formatPrOutput = (
    pr: any,
    policies: PolicyEvaluation[],
    workItems: { id: string; title: string; type: string; state: string }[],
  ): string => {
    const lines: string[] = [];

    // Header
    lines.push(`## PR #${pr.pullRequestId}: ${pr.title || "(untitled)"}`);
    lines.push("");

    // Metadata
    const fields = [
      formatField("Status", pr.status),
      formatField("Draft", pr.isDraft ? "Yes" : "No"),
      formatField("Source", stripRefPrefix(pr.sourceRefName || "")),
      formatField("Target", stripRefPrefix(pr.targetRefName || "")),
      formatField("Merge Status", pr.mergeStatus),
      formatField("Created By", pr.createdBy),
      formatField("Created", pr.creationDate),
      formatField("Repository", pr.repository?.name),
      formatField(
        "Last Merge Commit",
        pr.lastMergeSourceCommit?.commitId?.slice(0, 8),
      ),
    ].filter(Boolean);

    if (pr.labels?.length) {
      fields.push(
        formatField("Labels", pr.labels.map((l: any) => l.name).join(", ")),
      );
    }

    lines.push(fields.join("\n"));
    lines.push("");

    // Description
    lines.push("### Description");
    lines.push(stripHtml(pr.description));
    lines.push("");

    // Reviewers
    if (pr.reviewers?.length) {
      lines.push("### Reviewers");
      for (const r of pr.reviewers as Reviewer[]) {
        const vote = VOTE_LABELS[r.vote] || `Vote: ${r.vote}`;
        const required = r.isRequired ? " (required)" : "";
        const declined = r.hasDeclined ? " [DECLINED]" : "";
        lines.push(`- ${r.displayName}: ${vote}${required}${declined}`);
      }
      lines.push("");
    }

    // Policies
    if (policies.length) {
      const classified = classifyBuilds(policies, cfg);

      if (classified.waitFor.length || classified.noWait.length) {
        lines.push("### Build Policies");
        for (const build of [...classified.waitFor, ...classified.noWait]) {
          const isNoWait = classified.noWait.includes(build);
          const suffix = isNoWait ? " (no-wait)" : "";
          lines.push(formatBuildLine(build) + suffix);
        }
        lines.push("");
      }

      if (classified.other.length) {
        lines.push("### Other Policies");
        for (const policy of classified.other) {
          const name = policy.configuration.type.displayName;
          const icon = statusIcon(policy.status);
          const blocking = policy.configuration.isBlocking ? "" : " (optional)";
          lines.push(`${icon.padEnd(10)} ${name}${blocking}`);
        }
        lines.push("");
      }
    }

    // Linked Work Items
    if (workItems.length) {
      lines.push("### Linked Work Items");
      for (const wi of workItems) {
        const typeTag = wi.type ? `[${wi.type}]` : "";
        const stateTag = wi.state ? `(${wi.state})` : "";
        lines.push(`- #${wi.id} ${typeTag} ${wi.title} ${stateTag}`.trimEnd());
      }
      lines.push("");
    }

    return lines.join("\n");
  };

  // ── Watch builds polling loop ────────────────────────────────────────
  const watchBuilds = async (id: number, org: string): Promise<string> => {
    const interval = cfg.watchInterval;
    const timeout = cfg.watchTimeout;
    const startTime = Date.now();
    let pollCount = 0;

    while (true) {
      pollCount++;
      const elapsed = (Date.now() - startTime) / 1000;

      if (elapsed >= timeout) {
        // Timeout — return current status
        const policies = await fetchPolicies(id, org);
        const { waitFor, noWait, other } = classifyBuilds(policies, cfg);
        const lines = [
          `## PR #${id} Build Status — TIMEOUT`,
          "",
          `Timed out after ${formatDuration(new Date(startTime).toISOString())} (${pollCount} polls)`,
          "",
        ];

        if (waitFor.length) {
          lines.push("### Builds");
          for (const b of waitFor) lines.push(formatBuildLine(b));
          lines.push("");
        }
        if (noWait.length) {
          lines.push("### No-Wait Builds (not waited on — involves manual QA)");
          for (const b of noWait) lines.push(formatBuildLine(b));
          lines.push("");
        }
        if (other.length) {
          lines.push("### Other Policies");
          for (const p of other) {
            lines.push(
              `${statusIcon(p.status).padEnd(10)} ${p.configuration.type.displayName}`,
            );
          }
          lines.push("");
        }

        return lines.join("\n");
      }

      const policies = await fetchPolicies(id, org);
      const { waitFor, noWait, other } = classifyBuilds(policies, cfg);

      // Check completion conditions
      const allApproved = waitFor.every((b) => b.status === "approved");
      const anyFailed = waitFor.some((b) => b.status === "rejected");

      if (allApproved && waitFor.length > 0) {
        // All wait-for builds passed
        const totalTime = formatDuration(new Date(startTime).toISOString());
        const passed = waitFor.length;
        const lines = [
          `## PR #${id} Build Status — SUCCESS`,
          "",
          `### Builds (${passed}/${passed} passed)`,
        ];
        for (const b of waitFor) lines.push(formatBuildLine(b));
        lines.push("");

        if (noWait.length) {
          lines.push("### No-Wait Builds (not waited on — involves manual QA)");
          for (const b of noWait) lines.push(formatBuildLine(b));
          lines.push("");
        }
        if (other.length) {
          lines.push("### Other Policies");
          for (const p of other) {
            lines.push(
              `${statusIcon(p.status).padEnd(10)} ${p.configuration.type.displayName}`,
            );
          }
          lines.push("");
        }

        lines.push(`Completed in ${totalTime} (${pollCount} polls)`);
        return lines.join("\n");
      }

      if (anyFailed) {
        // At least one wait-for build failed
        const failed = waitFor.filter((b) => b.status === "rejected");
        const passed = waitFor.filter((b) => b.status === "approved");
        const total = waitFor.length;
        const lines = [
          `## PR #${id} Build Status — FAILED`,
          "",
          `### Builds (${passed.length}/${total} passed, ${failed.length} FAILED)`,
        ];
        for (const b of waitFor) {
          lines.push(formatBuildLine(b));
          if (b.status === "rejected" && b.context?.buildId) {
            lines.push(
              `          Use \`az pipelines runs show --id ${b.context.buildId}\` to investigate`,
            );
          }
        }
        lines.push("");

        if (noWait.length) {
          lines.push("### No-Wait Builds (not waited on — involves manual QA)");
          for (const b of noWait) lines.push(formatBuildLine(b));
          lines.push("");
        }
        if (other.length) {
          lines.push("### Other Policies");
          for (const p of other) {
            lines.push(
              `${statusIcon(p.status).padEnd(10)} ${p.configuration.type.displayName}`,
            );
          }
          lines.push("");
        }

        const totalTime = formatDuration(new Date(startTime).toISOString());
        lines.push(`Failed after ${totalTime} (${pollCount} polls)`);
        return lines.join("\n");
      }

      // Still in progress — sleep and poll again
      await Bun.sleep(interval * 1000);
    }
  };

  // ─── Register Tool ──────────────────────────────────────────────────────────

  return [
    "get-pr",
    tool({
      description:
        "Fetch Azure DevOps pull request metadata (description, reviewers, " +
        "build policies, linked work items). Use watch=true to block until " +
        "builds complete or fail. Accepts a raw PR ID number.",
      args: {
        id: tool.schema.string(),
        watch: tool.schema.optional(tool.schema.boolean()),
      },
      async execute(args) {
        // Parse PR ID
        const prId = parseInt(args.id, 10);
        if (isNaN(prId)) {
          return `Invalid PR ID: "${args.id}". Provide a numeric PR ID.`;
        }

        // Resolve org/project
        const orgProject = await resolveOrgProject();
        if (!orgProject) {
          return "Could not determine Azure DevOps organization/project. Set AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT env vars or ensure git remote is configured.";
        }
        const { org, project } = orgProject;

        if (args.watch) {
          // Watch mode — block until builds complete
          try {
            return await watchBuilds(prId, org);
          } catch (e: any) {
            return `Watch mode error: ${e.message || e}`;
          }
        }

        // Default mode — fetch metadata + policies + work items
        try {
          const [pr, policies] = await Promise.all([
            fetchPrMetadata(prId, org),
            fetchPolicies(prId, org),
          ]);

          // Fetch linked work items in parallel
          const workItems = await fetchWorkItems(pr.workItemRefs || [], org);

          return formatPrOutput(pr, policies, workItems);
        } catch (e: any) {
          return `Error fetching PR #${prId}: ${e.message || e}`;
        }
      },
    }),
  ] as const;
}
