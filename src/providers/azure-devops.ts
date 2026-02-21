import { Terminal } from "bun-pty";
import { registerProvider } from "./registry";
import { stripAnsi } from "../utils";
import type {
  Provider,
  RepoInfo,
  WorkItemResult,
  WorkItemRelation,
  BuildRun,
  CreatePrResult,
  PrResult,
  PrReviewer,
  PrPolicy,
  PrWorkItem,
  PrCommentThread,
} from "./types";

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

const VOTE_MAP: Record<number, string> = {
  10: "approved",
  5: "approvedWithSuggestions",
  0: "none",
  [-5]: "waitingForAuthor",
  [-10]: "rejected",
};

type ParsedWorkItem = {
  id: number;
  org?: string;
  project?: string;
};

const parseWorkItemInput = (input: string): ParsedWorkItem | null => {
  const num = parseInt(input, 10);
  if (!isNaN(num) && String(num) === input.trim()) return { id: num };

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

  const orgMatch = input.match(
    /https?:\/\/dev\.azure\.com(?:\.mcas\.ms)?\/([^/]+)\/([^/]+)/i,
  );
  const org = orgMatch ? `https://dev.azure.com/${orgMatch[1]}` : undefined;
  const project = orgMatch ? orgMatch[2] : undefined;

  return { id, org, project };
};

type ParsedPrInput = {
  id: number;
  org?: string;
  project?: string;
};

const parsePrInput = (input: string): ParsedPrInput | null => {
  const num = parseInt(input, 10);
  if (!isNaN(num) && String(num) === input.trim()) return { id: num };

  // Match PR URLs like:
  //   https://dev.azure.com/Org/Project/_git/Repo/pullrequest/12345
  //   https://dev.azure.com.mcas.ms/Org/Project/_git/Repo/pullrequest/12345
  const prIdPattern = /\/pullrequest\/(\d+)/i;
  const match = input.match(prIdPattern);
  if (!match) return null;

  const id = parseInt(match[1], 10);
  const orgMatch = input.match(
    /https?:\/\/dev\.azure\.com(?:\.mcas\.ms)?\/([^/]+)\/([^/]+)/i,
  );
  const org = orgMatch ? `https://dev.azure.com/${orgMatch[1]}` : undefined;
  const project = orgMatch ? orgMatch[2] : undefined;

  return { id, org, project };
};

const extractIdFromUrl = (url: string): number | null => {
  const match = url.match(/\/workItems\/(\d+)$/i);
  return match ? parseInt(match[1], 10) : null;
};

// ─── Azure DevOps Provider ───────────────────────────────────────────────────

const azureDevOps: Provider = {
  name: "azure-devops",

  async resolveRepo(root, $) {
    let org = process.env.AZURE_DEVOPS_ORG || "";
    let project = process.env.AZURE_DEVOPS_PROJECT || "";

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
      throw new Error(
        "Could not determine organization/project. Provide them as arguments or set AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT env vars.",
      );
    }

    if (!org.startsWith("http")) {
      org = `https://dev.azure.com/${org}`;
    }

    return { org, project };
  },

  // ── Work Item ─────────────────────────────────────────────────────────

  async fetchWorkItem(ref, config, root, $) {
    const parsed = parseWorkItemInput(ref);
    if (!parsed) {
      throw new Error(
        `Could not parse work item ID from: "${ref}". Provide a numeric ID or Azure DevOps URL.`,
      );
    }
    const workItemId = parsed.id;

    // Resolve org/project — URL-parsed values can override
    let repo: RepoInfo;
    try {
      repo = await this.resolveRepo(root, $);
    } catch {
      repo = { org: "", project: "" };
    }
    const org = parsed.org || repo.org;
    const project = parsed.project || repo.project;

    if (!org || !project) {
      throw new Error(
        "Could not determine organization/project. Provide them as arguments or set AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT env vars.",
      );
    }

    // Fetch work item with relations
    const result =
      await $`az boards work-item show --id ${workItemId} --org ${org} --expand Relations --output json 2>&1`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to fetch work item #${workItemId} (exit ${result.exitCode}):\n${result.stdout.toString().slice(0, 2000)}`,
      );
    }

    let item: any;
    try {
      item = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error(
        `Failed to parse work item response:\n${result.stdout.toString().slice(0, 2000)}`,
      );
    }

    const fields = item.fields || {};

    // Fetch related work items
    const rawRelations: any[] = item.relations || [];
    const workItemRelations = rawRelations.filter(
      (r) => r.url && RELATION_LABELS[r.rel],
    );

    const relations: WorkItemRelation[] = [];

    if (workItemRelations.length > 0) {
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

      // Fetch related items in parallel
      const relatedMap = new Map<number, any>();
      await Promise.all(
        relatedIds.map(async (r) => {
          try {
            const res =
              await $`az boards work-item show --id ${r.id} --org ${org} --output json 2>&1`
                .nothrow()
                .quiet();
            if (res.exitCode === 0) {
              const wi = JSON.parse(res.stdout.toString());
              if (wi.id) relatedMap.set(wi.id, wi);
            }
          } catch {
            // skip
          }
        }),
      );

      for (const { id, relation } of relatedIds) {
        const wi = relatedMap.get(id);
        const f = wi?.fields || {};
        relations.push({
          id,
          type: f["System.WorkItemType"] || "?",
          title: f["System.Title"] || "(unknown)",
          state: f["System.State"] || "?",
          relation,
        });
      }

      // Fetch siblings if single parent
      const parentItems = relatedIds.filter((r) => r.relation === "Parent");
      if (parentItems.length === 1) {
        const parentId = parentItems[0].id;
        const parentResult =
          await $`az boards work-item show --id ${parentId} --org ${org} --expand Relations --output json 2>&1`
            .nothrow()
            .quiet();

        if (parentResult.exitCode === 0) {
          try {
            const parent = JSON.parse(parentResult.stdout.toString());
            const parentRels: any[] = parent.relations || [];
            const siblingIds: number[] = [];
            for (const rel of parentRels) {
              if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
                const sibId = extractIdFromUrl(rel.url);
                if (sibId && sibId !== workItemId) {
                  siblingIds.push(sibId);
                }
              }
            }

            if (siblingIds.length > 0) {
              const sibItems: any[] = [];
              await Promise.all(
                siblingIds.map(async (sibId) => {
                  try {
                    const res =
                      await $`az boards work-item show --id ${sibId} --org ${org} --output json 2>&1`
                        .nothrow()
                        .quiet();
                    if (res.exitCode === 0) {
                      sibItems.push(JSON.parse(res.stdout.toString()));
                    }
                  } catch {
                    // skip
                  }
                }),
              );

              for (const sib of sibItems) {
                const sf = sib.fields || {};
                relations.push({
                  id: sib.id,
                  type: sf["System.WorkItemType"] || "?",
                  title: sf["System.Title"] || "(unknown)",
                  state: sf["System.State"] || "?",
                  relation: `Sibling (child of #${parentId})`,
                });
              }
            }
          } catch {
            // ignore parent fetch errors
          }
        }
      }
    }

    const assignedTo = fields["System.AssignedTo"];
    const assignedStr =
      typeof assignedTo === "object"
        ? assignedTo?.displayName || assignedTo?.uniqueName || ""
        : String(assignedTo || "");

    return {
      id: workItemId,
      title: fields["System.Title"] || "(no title)",
      type: fields["System.WorkItemType"] || "",
      state: fields["System.State"] || "",
      assignedTo: assignedStr,
      description: fields["System.Description"] || "",
      url: `${org}/${project}/_workitems/edit/${workItemId}`,
      fields, // pass all raw fields for tool-level rendering
      relations,
    };
  },

  // ── Build Runs ────────────────────────────────────────────────────────

  async fetchBuildRuns(branch, config, root, $) {
    const repo = await this.resolveRepo(root, $);
    const { org, project } = repo;
    const top = config.topBuilds ?? 3;

    const result =
      await $`az pipelines runs list --org ${org} --project ${project} --branch ${branch} --top ${String(top)} --output json 2>&1`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      throw new Error(
        `CLI error (exit ${result.exitCode}):\n${result.stdout.toString()}`,
      );
    }

    const runs = JSON.parse(result.stdout.toString());
    if (!Array.isArray(runs) || runs.length === 0) {
      return [];
    }

    return runs.map((run: any): BuildRun => {
      const rawStatus = (run.result || run.status || "unknown").toLowerCase();
      let status: string;
      switch (rawStatus) {
        case "succeeded":
          status = "succeeded";
          break;
        case "failed":
          status = "failed";
          break;
        case "inprogress":
        case "notstarted":
          status = "inProgress";
          break;
        case "canceled":
        case "cancelled":
          status = "cancelled";
          break;
        default:
          status = rawStatus;
      }

      return {
        id: String(run.id || "?"),
        name: run.definition?.name || run.pipeline?.name || "Unknown",
        status,
        branch,
        url: run._links?.web?.href || "",
        startedAt: run.startTime,
        completedAt: run.finishTime,
      };
    });
  },

  // ── Create PR ─────────────────────────────────────────────────────────

  async createPr(args, config, root) {
    const cmdArgs = [...config.args];
    if (args.title) cmdArgs.push("--title", args.title);
    if (args.body) cmdArgs.push("--description", args.body);
    if (args.draft) cmdArgs.push("--draft");
    if (args.targetBranch) cmdArgs.push("--targetBranch", args.targetBranch);

    const urlPatternRegex = config.urlPattern
      ? new RegExp(config.urlPattern)
      : /https?:\/\/[^\s)]+/;

    return new Promise<CreatePrResult>((resolve, reject) => {
      const terminal = new Terminal(config.command, cmdArgs, {
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
          reject(
            new Error(`PR creation timed out after ${config.timeout}s`),
          );
        }
      }, config.timeout * 1000);

      terminal.onData((data: string) => {
        output.push(data);
        accumulated += data;
        const buf = stripAnsi(accumulated);

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
        const urlMatch = fullOutput.match(urlPatternRegex);

        if (exitCode === 0 && urlMatch) {
          const titleMatch = fullOutput.match(/Title:\s*(.+)/);
          resolve({
            url: urlMatch[0],
            title: titleMatch ? titleMatch[1].trim() : args.title,
          });
        } else if (exitCode === 0) {
          // Success but no URL found
          const lines = fullOutput
            .split("\n")
            .filter(
              (l) =>
                l.trim().length > 0 &&
                !l.includes("\u250c") &&
                !l.includes("\u2514") &&
                !l.includes("\u2502") &&
                !l.includes("\u2500") &&
                !/[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/.test(l),
            );
          resolve({
            url: lines.slice(-3).join("\n"),
            title: args.title,
          });
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
          reject(
            new Error(
              `PR creation failed (exit code: ${exitCode}).\n${errorLines.length > 0 ? errorLines.join("\n") : fullOutput.slice(-500)}`,
            ),
          );
        }
      });
    });
  },

  // ── Fetch PR ──────────────────────────────────────────────────────────

  async fetchPr(ref, config, root, $) {
    const parsed = parsePrInput(ref);
    if (!parsed) {
      throw new Error(
        `Could not parse PR ID from: "${ref}". Provide a numeric ID or Azure DevOps PR URL.`,
      );
    }
    const prId = parsed.id;

    let repo: RepoInfo;
    try {
      repo = await this.resolveRepo(root, $);
    } catch {
      repo = { org: "", project: "" };
    }
    const org = parsed.org || repo.org;

    if (!org) {
      throw new Error(
        "Could not determine organization. Provide a PR URL or set AZURE_DEVOPS_ORG env var.",
      );
    }

    // Fetch PR metadata
    const prResult =
      await $`az repos pr show --id ${prId} --org ${org} --output json`
        .nothrow()
        .quiet();
    const prOutput = prResult.stdout.toString().trim();
    if (prResult.exitCode !== 0 || !prOutput) {
      throw new Error(
        `Failed to fetch PR #${prId}: ${prResult.stderr?.toString().trim() || "No output"}`,
      );
    }
    const pr = JSON.parse(prOutput);

    // Fetch policies
    const policyResult =
      await $`az repos pr policy list --id ${prId} --org ${org} --output json`
        .nothrow()
        .quiet();
    const rawPolicies: any[] = (() => {
      const out = policyResult.stdout.toString().trim();
      if (policyResult.exitCode !== 0 || !out) return [];
      try {
        return JSON.parse(out);
      } catch {
        return [];
      }
    })();

    // Normalize policies
    const policies: PrPolicy[] = rawPolicies.map((p: any) => ({
      name:
        p.context?.buildDefinitionName ||
        p.configuration?.type?.displayName ||
        "Unknown",
      type: p.configuration?.type?.displayName === "Build" ? "build" : "other",
      status: p.status,
      isBlocking: p.configuration?.isBlocking ?? true,
      buildId: p.context?.buildId ? String(p.context.buildId) : undefined,
      startedAt: p.startedDate,
      completedAt: p.completedDate,
    }));

    // Fetch linked work items
    const workItemRefs: any[] = pr.workItemRefs || [];
    const workItems: PrWorkItem[] = [];
    if (workItemRefs.length > 0) {
      await Promise.all(
        workItemRefs.map(async (wiRef: any) => {
          try {
            const res =
              await $`az boards work-item show --id ${wiRef.id} --org ${org} --output json`
                .nothrow()
                .quiet();
            const out = res.stdout.toString().trim();
            if (res.exitCode === 0 && out) {
              const wi = JSON.parse(out);
              const f = wi.fields || {};
              workItems.push({
                id: wiRef.id,
                title: f["System.Title"] || "(untitled)",
                type: f["System.WorkItemType"] || "",
                state: f["System.State"] || "",
              });
            } else {
              workItems.push({
                id: wiRef.id,
                title: "(fetch failed)",
                type: "",
                state: "",
              });
            }
          } catch {
            workItems.push({
              id: wiRef.id,
              title: "(error)",
              type: "",
              state: "",
            });
          }
        }),
      );
    }

    // Normalize reviewers
    const reviewers: PrReviewer[] = (pr.reviewers || []).map((r: any) => ({
      name: r.displayName || r.uniqueName || "Unknown",
      vote: VOTE_MAP[r.vote] || "none",
      isRequired: r.isRequired ?? false,
    }));

    const stripRef = (s: string) => s.replace(/^refs\/heads\//, "");

    const createdBy =
      typeof pr.createdBy === "object"
        ? pr.createdBy?.displayName ||
          pr.createdBy?.uniqueName ||
          JSON.stringify(pr.createdBy)
        : String(pr.createdBy || "");

    return {
      id: pr.pullRequestId,
      title: pr.title || "(untitled)",
      status: pr.status || "",
      isDraft: pr.isDraft ?? false,
      sourceBranch: stripRef(pr.sourceRefName || ""),
      targetBranch: stripRef(pr.targetRefName || ""),
      description: pr.description || "",
      url:
        pr._links?.web?.href ||
        `${org}/${repo.project}/_git/pullrequest/${pr.pullRequestId}`,
      createdBy,
      createdDate: pr.creationDate || "",
      mergeStatus: pr.mergeStatus || "",
      reviewers,
      policies,
      workItems,
      labels: (pr.labels || []).map((l: any) => l.name),
      repository: pr.repository?.name,
    };
  },

  // ── Fetch PR Comments ──────────────────────────────────────────────────

  async fetchPrComments(ref, _config, root, $) {
    const parsed = parsePrInput(ref);
    if (!parsed) {
      throw new Error(
        `Could not parse PR ID from: "${ref}". Provide a numeric ID or Azure DevOps PR URL.`,
      );
    }
    const prId = parsed.id;

    let repo: RepoInfo;
    try {
      repo = await this.resolveRepo(root, $);
    } catch {
      repo = { org: "", project: "" };
    }
    const org = parsed.org || repo.org;
    const project = parsed.project || repo.project;

    if (!org || !project) {
      throw new Error(
        "Could not determine organization/project. Provide a PR URL or set AZURE_DEVOPS_ORG and AZURE_DEVOPS_PROJECT env vars.",
      );
    }

    // Resolve the repository name from the PR metadata
    const prResult =
      await $`az repos pr show --id ${prId} --org ${org} --output json`
        .nothrow()
        .quiet();
    if (prResult.exitCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${prId}: ${prResult.stderr?.toString().trim() || "No output"}`,
      );
    }
    const pr = JSON.parse(prResult.stdout.toString().trim());
    const repoId = pr.repository?.id || pr.repository?.name;
    if (!repoId) {
      throw new Error(
        `Could not determine repository for PR #${prId}.`,
      );
    }

    // Fetch comment threads via az devops invoke (REST: pullRequests/{prId}/threads)
    const result =
      await $`az devops invoke --area git --resource pullRequestThreads --route-parameters project=${project} repositoryId=${repoId} pullRequestId=${prId} --org ${org} --api-version 7.1 --output json`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to fetch PR comment threads (exit ${result.exitCode}):\n${result.stdout.toString().slice(0, 2000)}`,
      );
    }

    let data: any;
    try {
      data = JSON.parse(result.stdout.toString());
    } catch {
      throw new Error(
        `Failed to parse comment threads response:\n${result.stdout.toString().slice(0, 2000)}`,
      );
    }

    const rawThreads: any[] = data.value || data || [];

    const threads: PrCommentThread[] = [];
    for (const thread of rawThreads) {
      const comments = (thread.comments || []).filter(
        (c: any) => c.commentType !== "system",
      );
      if (comments.length === 0) continue;

      const ctx = thread.threadContext;
      threads.push({
        id: thread.id,
        status: thread.status || "unknown",
        filePath: ctx?.filePath || null,
        line:
          ctx?.rightFileEnd?.line || ctx?.rightFileStart?.line || null,
        comments: comments.map((c: any) => ({
          author: c.author?.displayName || "Unknown",
          content: c.content || "",
          date: c.publishedDate || "",
        })),
      });
    }

    return threads;
  },
};

// ── Register ────────────────────────────────────────────────────────────────

registerProvider(azureDevOps);
