import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";
import { getProvider } from "../providers";
import type { WorkItemResult } from "../providers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatField = (label: string, value: any): string => {
  if (value === undefined || value === null || value === "") return "";
  const strVal =
    typeof value === "object"
      ? value.displayName || value.uniqueName || JSON.stringify(value)
      : String(value);
  return `**${label}:** ${strVal}`;
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

// ─── Tool Factory ─────────────────────────────────────────────────────────────

export function createWorkItemTool(
  config: DevToolsConfig,
  root: string,
  $: any,
) {
  const cfg = config.workItem;

  return [
    "work-item",
    tool({
      description:
        `Fetch work item / issue details including description, ` +
        "acceptance criteria, related items, and metadata. Accepts an ID or URL. " +
        "Pass provider to override the global setting (e.g. 'github' or 'azure-devops').",
      args: {
        id: tool.schema.string(),
        provider: tool.schema.optional(tool.schema.string()),
        organization: tool.schema.optional(tool.schema.string()),
        project: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        try {
          const provider = getProvider(args.provider || config.provider);
          const result: WorkItemResult = await provider.fetchWorkItem(
            args.id,
            { ...cfg, organization: args.organization, project: args.project },
            root,
            $,
          );
          return formatWorkItemResult(result, cfg);
        } catch (e: any) {
          return `Error fetching work item: ${e.message || e}`;
        }
      },
    }),
  ] as const;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatWorkItemResult(
  result: WorkItemResult,
  cfg: DevToolsConfig["workItem"],
): string {
  const lines: string[] = [];

  lines.push(`# Work Item #${result.id}: ${result.title || "(no title)"}`);
  lines.push("");

  // Core metadata
  const meta = [
    formatField("Type", result.type),
    formatField("State", result.state),
    formatField("Assigned To", result.assignedTo),
    formatField("URL", result.url),
  ].filter(Boolean);

  // Extra fields from provider (Azure DevOps has many, GitHub has fewer)
  if (result.fields) {
    // Render well-known fields
    const RENDERED_KEYS = new Set([
      "System.Title",
      "System.WorkItemType",
      "System.State",
      "System.AssignedTo",
    ]);

    const wellKnown: [string, string][] = [
      ["System.Reason", "Reason"],
      ["System.BoardColumn", "Board Column"],
      ["System.AreaPath", "Area Path"],
      ["System.IterationPath", "Iteration Path"],
      ["Microsoft.VSTS.Scheduling.StoryPoints", "Story Points"],
      ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Original Estimate"],
      ["Microsoft.VSTS.Common.Priority", "Priority"],
      ["Microsoft.VSTS.Common.Severity", "Severity"],
      ["System.Tags", "Tags"],
      ["System.CreatedBy", "Created By"],
      ["System.CreatedDate", "Created Date"],
      ["System.ChangedDate", "Changed Date"],
      // GitHub fields
      ["milestone", "Milestone"],
      ["labels", "Labels"],
      ["createdAt", "Created"],
      ["closedAt", "Closed"],
      ["stateReason", "State Reason"],
    ];

    for (const [key, label] of wellKnown) {
      RENDERED_KEYS.add(key);
      const val = result.fields[key];
      if (val !== undefined && val !== null && val !== "") {
        meta.push(formatField(label, val));
      }
    }
  }

  if (meta.length) {
    lines.push("## Metadata");
    lines.push(...meta);
    lines.push("");
  }

  // Description
  lines.push("## Description");
  const desc = result.description || "(none)";
  // Strip HTML if it looks like HTML
  lines.push(desc.includes("<") ? stripHtml(desc) : desc);
  lines.push("");

  // Extra fields from provider (acceptance criteria, testing details, etc.)
  if (result.fields) {
    const extraSections: [string, string, string][] = [
      [
        "Microsoft.VSTS.Common.AcceptanceCriteria",
        "Acceptance Criteria",
        "html",
      ],
      ["Microsoft.VSTS.TCM.TestingDetails", "Testing Details", "html"],
      ["Custom.TestingDetails", "Testing Details", "html"],
      ["Microsoft.VSTS.TCM.ReproSteps", "Repro Steps", "html"],
    ];

    for (const [key, heading, format] of extraSections) {
      const val = result.fields[key];
      if (val) {
        lines.push(`## ${heading}`);
        lines.push(format === "html" ? stripHtml(val) : val);
        lines.push("");
      }
    }

    // Requirement Links (custom VectorVest field — extract URLs from HTML)
    const reqLinksHtml = result.fields["VectorVest.Common.RequirementLinks"];
    if (reqLinksHtml) {
      lines.push("## Requirement Links");
      const linkRegex = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
      let linkMatch;
      const extractedLinks: string[] = [];
      while ((linkMatch = linkRegex.exec(reqLinksHtml)) !== null) {
        const url = linkMatch[1];
        const text = linkMatch[2] || url;
        extractedLinks.push(`- [${text}](${url})`);
      }
      if (extractedLinks.length > 0) {
        lines.push(...extractedLinks);
      } else {
        lines.push(stripHtml(reqLinksHtml));
      }
      lines.push("");
    }

    // Additional configured fields not already rendered
    const RENDERED_FIELDS = new Set([
      "System.Title",
      "System.WorkItemType",
      "System.State",
      "System.Reason",
      "System.BoardColumn",
      "System.AssignedTo",
      "System.AreaPath",
      "System.IterationPath",
      "System.CreatedBy",
      "System.CreatedDate",
      "System.ChangedDate",
      "Microsoft.VSTS.Scheduling.StoryPoints",
      "Microsoft.VSTS.Scheduling.OriginalEstimate",
      "Microsoft.VSTS.Common.Priority",
      "Microsoft.VSTS.Common.Severity",
      "System.Tags",
      "System.Description",
      "Microsoft.VSTS.Common.AcceptanceCriteria",
      "Microsoft.VSTS.TCM.TestingDetails",
      "Custom.TestingDetails",
      "Microsoft.VSTS.TCM.ReproSteps",
      "VectorVest.Common.RequirementLinks",
      "milestone",
      "labels",
      "createdAt",
      "closedAt",
      "stateReason",
    ]);

    for (const fieldRef of cfg.fields) {
      if (RENDERED_FIELDS.has(fieldRef)) continue;
      const val = result.fields[fieldRef];
      if (val !== undefined && val !== null && val !== "") {
        const label = fieldRef.split(".").pop() || fieldRef;
        lines.push(
          `**${label}:** ${typeof val === "string" && val.includes("<") ? stripHtml(val) : val}`,
        );
      }
    }
  }

  // Related work items
  if (result.relations && result.relations.length > 0) {
    lines.push("");
    lines.push("## Related Work Items");

    // Group by relation type
    const grouped = new Map<string, typeof result.relations>();
    for (const rel of result.relations) {
      const group = grouped.get(rel.relation) || [];
      group.push(rel);
      grouped.set(rel.relation, group);
    }

    const order = [
      "Parent",
      "Child",
      "Sibling",
      "Related",
      "Predecessor",
      "Successor",
    ];
    const sortedKeys = [...grouped.keys()].sort(
      (a, b) =>
        (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
        (order.indexOf(b) === -1 ? 99 : order.indexOf(b)),
    );

    const pluralize = (s: string, n: number) => {
      if (n <= 1) return s;
      if (s === "Child") return "Children";
      return `${s}s`;
    };

    for (const rel of sortedKeys) {
      const items = grouped.get(rel)!;
      lines.push("");
      lines.push(`### ${pluralize(rel, items.length)}`);
      for (const wi of items) {
        const typeTag = wi.type ? `[${wi.type}]` : "";
        lines.push(`- #${wi.id} ${typeTag} ${wi.title} (${wi.state})`);
      }
    }
  }

  return lines.join("\n");
}
