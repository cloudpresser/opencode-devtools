import { tool } from "@opencode-ai/plugin";
import type { DevToolsConfig } from "../config";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkItemRelation {
  rel: string;
  url: string;
  attributes: Record<string, any>;
}

interface RelatedItem {
  id: number;
  type: string;
  title: string;
  state: string;
  relation: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RELATION_LABELS: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Related": "Related",
  "System.LinkTypes.Dependency-Forward": "Successor",
  "System.LinkTypes.Dependency-Reverse": "Predecessor",
  "Microsoft.VSTS.Common.Affects-Forward": "Affects",
  "Microsoft.VSTS.Common.Affects-Reverse": "Affected By",
};

type ParsedWorkItem = {
  id: number;
  org?: string;
  project?: string;
};

const parseWorkItemInput = (input: string): ParsedWorkItem | null => {
  // Pure numeric ID
  const num = parseInt(input, 10);
  if (!isNaN(num) && String(num) === input.trim()) return { id: num };

  // URL patterns for work item ID
  const idPatterns = [
    /[?&]workitem=(\d+)/i,
    /\/_workitems\/edit\/(\d+)/i,
    /\/workitem\/(\d+)/i,
  ];

  let id: number | null = null;
  for (const pattern of idPatterns) {
    const match = input.match(pattern);
    if (match) {
      id = parseInt(match[1], 10);
      break;
    }
  }

  if (!id) return null;

  // Extract org/project from URL
  // Handles: dev.azure.com/{org}/{project}/... and dev.azure.com.mcas.ms/{org}/{project}/...
  const orgMatch = input.match(
    /https?:\/\/dev\.azure\.com(?:\.mcas\.ms)?\/([^/]+)\/([^/]+)/i,
  );
  const org = orgMatch ? `https://dev.azure.com/${orgMatch[1]}` : undefined;
  const project = orgMatch ? orgMatch[2] : undefined;

  return { id, org, project };
};

const extractIdFromUrl = (url: string): number | null => {
  // API URLs: https://dev.azure.com/{org}/{project}/_apis/wit/workItems/{id}
  const match = url.match(/\/workItems\/(\d+)$/i);
  return match ? parseInt(match[1], 10) : null;
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

const formatField = (label: string, value: any): string => {
  if (value === undefined || value === null || value === "") return "";
  const strVal =
    typeof value === "object"
      ? value.displayName || value.uniqueName || JSON.stringify(value)
      : String(value);
  return `**${label}:** ${strVal}`;
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
        "Fetch Azure DevOps work item details including description, " +
        "acceptance criteria, story points, testing details, and related " +
        "work items (parent, children, siblings). Accepts a work item ID " +
        "or a full Azure DevOps URL.",
      args: {
        id: tool.schema.string(),
        organization: tool.schema.optional(tool.schema.string()),
        project: tool.schema.optional(tool.schema.string()),
      },
      async execute(args) {
        // ── Parse work item ID (and optionally org/project from URL) ─────
        const parsed = parseWorkItemInput(args.id);
        if (!parsed) {
          return `Could not parse work item ID from: "${args.id}". Provide a numeric ID or Azure DevOps URL.`;
        }
        const workItemId = parsed.id;

        // ── Resolve org/project ──────────────────────────────────────────
        // Priority: explicit args > URL-parsed > env vars > git remote
        let org =
          args.organization || parsed.org || process.env.AZURE_DEVOPS_ORG || "";
        let project =
          args.project ||
          parsed.project ||
          process.env.AZURE_DEVOPS_PROJECT ||
          "";

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
          return "Could not determine organization/project. Provide them as arguments or set AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT env vars.";
        }

        if (!org.startsWith("http")) {
          org = `https://dev.azure.com/${org}`;
        }

        // ── Fetch work item with relations ───────────────────────────────
        const result =
          await $`az boards work-item show --id ${workItemId} --org ${org} --expand Relations --output json 2>&1`
            .nothrow()
            .quiet();

        if (result.exitCode !== 0) {
          const output = result.stdout.toString();
          return `Failed to fetch work item #${workItemId} (exit ${result.exitCode}):\n${output.slice(0, 2000)}`;
        }

        let item: any;
        try {
          item = JSON.parse(result.stdout.toString());
        } catch {
          return `Failed to parse work item response:\n${result.stdout.toString().slice(0, 2000)}`;
        }

        const fields = item.fields || {};

        // ── Build main details ───────────────────────────────────────────
        const lines: string[] = [];

        lines.push(
          `# Work Item #${workItemId}: ${fields["System.Title"] || "(no title)"}`,
        );
        lines.push("");

        // Core metadata
        const meta = [
          formatField("Type", fields["System.WorkItemType"]),
          formatField("State", fields["System.State"]),
          formatField("Reason", fields["System.Reason"]),
          formatField("Board Column", fields["System.BoardColumn"]),
          formatField("Assigned To", fields["System.AssignedTo"]),
          formatField("Area Path", fields["System.AreaPath"]),
          formatField("Iteration Path", fields["System.IterationPath"]),
          formatField(
            "Story Points",
            fields["Microsoft.VSTS.Scheduling.StoryPoints"],
          ),
          formatField(
            "Original Estimate",
            fields["Microsoft.VSTS.Scheduling.OriginalEstimate"],
          ),
          formatField("Priority", fields["Microsoft.VSTS.Common.Priority"]),
          formatField("Severity", fields["Microsoft.VSTS.Common.Severity"]),
          formatField("Tags", fields["System.Tags"]),
          formatField("Created By", fields["System.CreatedBy"]),
          formatField("Created Date", fields["System.CreatedDate"]),
          formatField("Changed Date", fields["System.ChangedDate"]),
        ].filter(Boolean);

        if (meta.length) {
          lines.push("## Metadata");
          lines.push(...meta);
          lines.push("");
        }

        // Description
        lines.push("## Description");
        lines.push(stripHtml(fields["System.Description"]));
        lines.push("");

        // Acceptance Criteria
        const ac = fields["Microsoft.VSTS.Common.AcceptanceCriteria"];
        if (ac) {
          lines.push("## Acceptance Criteria");
          lines.push(stripHtml(ac));
          lines.push("");
        }

        // Testing Details (custom field or standard)
        const testingDetails =
          fields["Microsoft.VSTS.TCM.TestingDetails"] ||
          fields["Custom.TestingDetails"];
        if (testingDetails) {
          lines.push("## Testing Details");
          lines.push(stripHtml(testingDetails));
          lines.push("");
        }

        // Repro Steps (for bugs)
        const reproSteps = fields["Microsoft.VSTS.TCM.ReproSteps"];
        if (reproSteps) {
          lines.push("## Repro Steps");
          lines.push(stripHtml(reproSteps));
          lines.push("");
        }

        // Requirement Links (custom VectorVest field — extract URLs from HTML)
        const reqLinksHtml = fields["VectorVest.Common.RequirementLinks"];
        if (reqLinksHtml) {
          lines.push("## Requirement Links");
          // Extract href URLs and their text
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
            // Fallback: strip HTML and show as text
            lines.push(stripHtml(reqLinksHtml));
          }
          lines.push("");
        }

        // Additional configured fields
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
        ]);

        for (const fieldRef of cfg.fields) {
          if (RENDERED_FIELDS.has(fieldRef)) continue;

          const val = fields[fieldRef];
          if (val !== undefined && val !== null && val !== "") {
            const label = fieldRef.split(".").pop() || fieldRef;
            lines.push(
              `**${label}:** ${typeof val === "string" && val.includes("<") ? stripHtml(val) : val}`,
            );
          }
        }

        // ── Related work items ───────────────────────────────────────────
        const relations: WorkItemRelation[] = item.relations || [];
        const workItemRelations = relations.filter(
          (r) => r.url && RELATION_LABELS[r.rel],
        );

        if (workItemRelations.length > 0) {
          // Extract IDs from relation URLs
          const relatedIds: { id: number; relation: string }[] = [];
          for (const rel of workItemRelations) {
            const id = extractIdFromUrl(rel.url);
            if (id) {
              relatedIds.push({
                id,
                relation: RELATION_LABELS[rel.rel] || rel.rel,
              });
            }
          }

          if (relatedIds.length > 0) {
            // Fetch related items in parallel (az CLI only supports --id, not --ids)
            const relatedMap = new Map<number, any>();
            const fetches = relatedIds.map(async (r) => {
              try {
                const result =
                  await $`az boards work-item show --id ${r.id} --org ${org} --output json 2>&1`
                    .nothrow()
                    .quiet();
                if (result.exitCode === 0) {
                  const wi = JSON.parse(result.stdout.toString());
                  if (wi.id) relatedMap.set(wi.id, wi);
                }
              } catch {
                // Skip items that fail to fetch
              }
            });
            await Promise.all(fetches);

            // Group by relation type
            const grouped = new Map<string, RelatedItem[]>();
            for (const { id, relation } of relatedIds) {
              const wi = relatedMap.get(id);
              const f = wi?.fields || {};
              const entry: RelatedItem = {
                id,
                type: f["System.WorkItemType"] || "?",
                title: f["System.Title"] || "(unknown)",
                state: f["System.State"] || "?",
                relation,
              };
              if (!grouped.has(relation)) grouped.set(relation, []);
              grouped.get(relation)!.push(entry);
            }

            lines.push("");
            lines.push("## Related Work Items");

            // Show parent first, then children, then others
            const order = [
              "Parent",
              "Child",
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
                lines.push(
                  `- #${wi.id} [${wi.type}] ${wi.title} (${wi.state})`,
                );
              }
            }

            // If parent exists, fetch siblings (other children of the parent)
            const parentItems = relatedIds.filter(
              (r) => r.relation === "Parent",
            );
            if (parentItems.length === 1) {
              const parentId = parentItems[0].id;
              const parentResult =
                await $`az boards work-item show --id ${parentId} --org ${org} --expand Relations --output json 2>&1`
                  .nothrow()
                  .quiet();

              if (parentResult.exitCode === 0) {
                try {
                  const parent = JSON.parse(parentResult.stdout.toString());
                  const parentRelations: WorkItemRelation[] =
                    parent.relations || [];
                  const siblingIds: number[] = [];
                  for (const rel of parentRelations) {
                    if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
                      const sibId = extractIdFromUrl(rel.url);
                      if (sibId && sibId !== workItemId) {
                        siblingIds.push(sibId);
                      }
                    }
                  }

                  if (siblingIds.length > 0) {
                    // Fetch sibling summaries in parallel
                    const sibItems: any[] = [];
                    const sibFetches = siblingIds.map(async (sibId) => {
                      try {
                        const result =
                          await $`az boards work-item show --id ${sibId} --org ${org} --output json 2>&1`
                            .nothrow()
                            .quiet();
                        if (result.exitCode === 0) {
                          sibItems.push(JSON.parse(result.stdout.toString()));
                        }
                      } catch {
                        // Skip siblings that fail to fetch
                      }
                    });
                    await Promise.all(sibFetches);

                    if (sibItems.length > 0) {
                      lines.push("");
                      lines.push(
                        `### Siblings (other children of #${parentId})`,
                      );

                      for (const sib of sibItems) {
                        const sf = sib.fields || {};
                        lines.push(
                          `- #${sib.id} [${sf["System.WorkItemType"] || "?"}] ${sf["System.Title"] || "(unknown)"} (${sf["System.State"] || "?"})`,
                        );
                      }
                    }
                  }
                } catch {
                  // ignore parent fetch errors
                }
              }
            }
          }
        }

        // ── Links (non-work-item) ────────────────────────────────────────
        const artifactLinks = relations.filter(
          (r) => !RELATION_LABELS[r.rel] && r.url,
        );
        if (artifactLinks.length > 0) {
          const urlLower = (u: string) => u.toLowerCase();
          const reqLinks = artifactLinks.filter(
            (r) =>
              r.rel === "ArtifactLink" ||
              r.attributes?.name === "Requirement" ||
              urlLower(r.url).includes("git") ||
              urlLower(r.url).includes("pullrequest"),
          );
          if (reqLinks.length > 0) {
            lines.push("");
            lines.push("## Linked Resources");
            for (const link of reqLinks) {
              const name =
                link.attributes?.name || link.attributes?.comment || link.rel;
              lines.push(`- [${name}] ${link.url}`);
            }
          }
        }

        return lines.join("\n");
      },
    }),
  ] as const;
}
