import { registerProvider } from "./registry";
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

/** Parse a GitHub issue/PR URL or plain number. */
const parseRef = (
  input: string,
): { number: number; owner?: string; repo?: string } | null => {
  const num = parseInt(input, 10);
  if (!isNaN(num) && String(num) === input.trim()) return { number: num };

  // https://github.com/{owner}/{repo}/issues/{number}
  // https://github.com/{owner}/{repo}/pull/{number}
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i,
  );
  if (urlMatch) {
    return {
      number: parseInt(urlMatch[3], 10),
      owner: urlMatch[1],
      repo: urlMatch[2],
    };
  }

  // #{number}
  const hashMatch = input.match(/^#(\d+)$/);
  if (hashMatch) return { number: parseInt(hashMatch[1], 10) };

  return null;
};

/** Normalize GitHub Actions run status + conclusion into our standard statuses. */
const normalizeRunStatus = (
  status: string,
  conclusion: string | null,
): string => {
  if (status === "completed") {
    switch (conclusion) {
      case "success":
        return "succeeded";
      case "failure":
        return "failed";
      case "cancelled":
        return "cancelled";
      default:
        return conclusion || "succeeded";
    }
  }
  if (status === "in_progress") return "inProgress";
  if (status === "queued" || status === "waiting" || status === "pending")
    return "queued";
  return status;
};

/** Normalize GitHub check status to our policy statuses. */
const normalizeCheckStatus = (state: string): string => {
  switch (state?.toUpperCase()) {
    case "SUCCESS":
      return "approved";
    case "FAILURE":
    case "ERROR":
      return "rejected";
    case "PENDING":
    case "EXPECTED":
      return "queued";
    default:
      return "running";
  }
};

/** Normalize GitHub review state to our vote labels. */
const normalizeReviewState = (state: string): string => {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "rejected";
    case "COMMENTED":
      return "none";
    case "DISMISSED":
      return "none";
    case "PENDING":
      return "waitingForAuthor";
    default:
      return "none";
  }
};

// ─── GitHub Provider ─────────────────────────────────────────────────────────

const github: Provider = {
  name: "github",

  async resolveRepo(root, $) {
    // Allow env-var overrides (mirrors azure-devops adapter)
    const envOwner = process.env.GITHUB_OWNER;
    const envRepo = process.env.GITHUB_REPO;
    if (envOwner && envRepo) {
      return { org: envOwner, project: envRepo };
    }

    try {
      const remote =
        await $`cd ${root} && git remote get-url origin 2>/dev/null`.quiet();
      const url = remote.stdout.toString().trim();

      // SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (sshMatch) {
        return { org: sshMatch[1], project: sshMatch[2].replace(/\.git$/, "") };
      }

      // HTTPS: https://github.com/owner/repo.git
      const httpsMatch = url.match(
        /github\.com\/([^/]+)\/([^/.]+)/,
      );
      if (httpsMatch) {
        return {
          org: httpsMatch[1],
          project: httpsMatch[2].replace(/\.git$/, ""),
        };
      }
    } catch {
      // ignore
    }

    throw new Error(
      "Could not determine GitHub owner/repo from git remote. Set GITHUB_OWNER and GITHUB_REPO env vars, or ensure the remote points to a GitHub repository.",
    );
  },

  // ── Work Item (GitHub Issue) ──────────────────────────────────────────

  async fetchWorkItem(ref, _config, root, $) {
    const parsed = parseRef(ref);
    if (!parsed) {
      throw new Error(
        `Could not parse issue number from: "${ref}". Provide a number or GitHub issue URL.`,
      );
    }

    const repo = await this.resolveRepo(root, $);
    const repoSlug = `${repo.org}/${repo.project}`;

    const result =
      await $`gh issue view ${parsed.number} --repo ${repoSlug} --json number,title,state,assignees,labels,body,milestone,url,closedAt,createdAt,stateReason,comments 2>&1`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to fetch issue #${parsed.number}: ${result.stdout.toString().slice(0, 2000)}`,
      );
    }

    const issue = JSON.parse(result.stdout.toString());

    const assignees = (issue.assignees || [])
      .map((a: any) => a.login || a.name)
      .join(", ");

    // GitHub issues don't have typed relations like Azure DevOps,
    // but we can extract cross-references from the body if present.
    const relations: WorkItemRelation[] = [];

    return {
      id: issue.number,
      title: issue.title || "(no title)",
      type: "Issue",
      state: issue.state || "",
      assignedTo: assignees,
      description: issue.body || "",
      url: issue.url || `https://github.com/${repoSlug}/issues/${issue.number}`,
      fields: {
        ...issue,
        labels: (issue.labels || []).map((l: any) => l.name).join(", "),
        milestone: issue.milestone?.title || "",
        comments: (issue.comments || []).length,
      },
      relations,
    };
  },

  // ── Build Runs (GitHub Actions) ───────────────────────────────────────

  async fetchBuildRuns(branch, config, root, $) {
    const repo = await this.resolveRepo(root, $);
    const repoSlug = `${repo.org}/${repo.project}`;
    const limit = config.topBuilds || 3;

    const result =
      await $`gh run list --repo ${repoSlug} --branch ${branch} --json databaseId,displayTitle,status,conclusion,headBranch,url,createdAt,workflowName,startedAt --limit ${limit} 2>&1`
        .nothrow()
        .quiet();

    if (result.exitCode !== 0) {
      throw new Error(
        `gh CLI error (exit ${result.exitCode}):\n${result.stdout.toString()}`,
      );
    }

    const runs = JSON.parse(result.stdout.toString());
    if (!Array.isArray(runs) || runs.length === 0) return [];

    return runs.map(
      (run: any): BuildRun => ({
        id: String(run.databaseId || "?"),
        name: run.workflowName || run.displayTitle || "Unknown",
        status: normalizeRunStatus(run.status || "", run.conclusion),
        branch: run.headBranch || branch,
        url: run.url || "",
        startedAt: run.startedAt || run.createdAt,
        completedAt: undefined, // gh run list doesn't include completedAt
      }),
    );
  },

  // ── Create PR ─────────────────────────────────────────────────────────

  async createPr(args, _config, root, $) {
    const cmdArgs = ["pr", "create"];
    if (args.title) {
      cmdArgs.push("--title", args.title);
    }
    if (args.body) {
      cmdArgs.push("--body", args.body);
    }
    if (args.draft) {
      cmdArgs.push("--draft");
    }
    if (args.targetBranch) {
      cmdArgs.push("--base", args.targetBranch);
    }
    // If no title/body provided, use --fill to auto-fill from commits
    if (!args.title && !args.body) {
      cmdArgs.push("--fill");
    }

    const result =
      await $`gh ${cmdArgs} 2>&1`
        .nothrow()
        .quiet()
        .cwd(root);

    const output = result.stdout.toString().trim();

    if (result.exitCode !== 0) {
      throw new Error(`PR creation failed (exit ${result.exitCode}):\n${output}`);
    }

    // gh pr create prints the PR URL on success
    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : output;

    return {
      url,
      title: args.title,
    };
  },

  // ── Fetch PR ──────────────────────────────────────────────────────────

  async fetchPr(ref, _config, root, $) {
    const parsed = parseRef(ref);
    if (!parsed) {
      throw new Error(`Invalid PR reference: "${ref}". Provide a number or GitHub PR URL.`);
    }

    const repo = await this.resolveRepo(root, $);
    const repoSlug = `${repo.org}/${repo.project}`;
    const prNumber = parsed.number;

    // Fetch PR details and checks in parallel
    const [prResult, checksResult] = await Promise.all([
      $`gh pr view ${prNumber} --repo ${repoSlug} --json number,title,state,isDraft,baseRefName,headRefName,body,url,mergeable,mergeStateStatus,reviews,reviewDecision,statusCheckRollup,closingIssuesReferences,author,createdAt,labels 2>&1`
        .nothrow()
        .quiet(),
      $`gh pr checks ${prNumber} --repo ${repoSlug} --json name,state,bucket,completedAt,description,link,workflow 2>&1`
        .nothrow()
        .quiet(),
    ]);

    if (prResult.exitCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${prNumber}: ${prResult.stdout.toString().slice(0, 2000)}`,
      );
    }

    const pr = JSON.parse(prResult.stdout.toString());

    // Parse checks
    let checks: any[] = [];
    if (checksResult.exitCode === 0) {
      try {
        checks = JSON.parse(checksResult.stdout.toString());
      } catch {
        // ignore parse errors
      }
    }

    // Normalize reviewers — deduplicate by taking latest review per author
    const reviewMap = new Map<string, PrReviewer>();
    for (const review of pr.reviews || []) {
      const name = review.author?.login || "Unknown";
      reviewMap.set(name, {
        name,
        vote: normalizeReviewState(review.state || ""),
        isRequired: false, // GitHub doesn't expose this in the same way
      });
    }
    const reviewers = [...reviewMap.values()];

    // Normalize checks into policies
    const policies: PrPolicy[] = (checks || []).map(
      (check: any): PrPolicy => ({
        name: check.name || "Unknown",
        type: "build",
        status: normalizeCheckStatus(check.state || ""),
        isBlocking: check.bucket !== "non_blocking",
        startedAt: undefined,
        completedAt: check.completedAt,
      }),
    );

    // Normalize closing issues references into work items
    const workItems: PrWorkItem[] = (pr.closingIssuesReferences || []).map(
      (issue: any): PrWorkItem => ({
        id: String(issue.number),
        title: issue.title || "(untitled)",
        type: "Issue",
        state: issue.state || "",
      }),
    );

    return {
      id: pr.number,
      title: pr.title || "(untitled)",
      status: pr.state || "",
      isDraft: pr.isDraft ?? false,
      sourceBranch: pr.headRefName || "",
      targetBranch: pr.baseRefName || "",
      description: pr.body || "",
      url: pr.url || `https://github.com/${repoSlug}/pull/${prNumber}`,
      createdBy: pr.author?.login || "",
      createdDate: pr.createdAt || "",
      mergeStatus: pr.mergeStateStatus || pr.mergeable || "",
      reviewers,
      policies,
      workItems,
      labels: (pr.labels || []).map((l: any) => l.name),
    };
  },

  // ── Fetch PR Comments ──────────────────────────────────────────────────

  async fetchPrComments(ref, _config, root, $) {
    const parsed = parseRef(ref);
    if (!parsed) {
      throw new Error(
        `Invalid PR reference: "${ref}". Provide a number or GitHub PR URL.`,
      );
    }

    const repo = await this.resolveRepo(root, $);
    const repoSlug = `${repo.org}/${repo.project}`;
    const prNumber = parsed.number;

    // Fetch review comments (file-level) and issue comments (top-level) in parallel
    const [reviewResult, issueResult] = await Promise.all([
      $`gh api repos/${repoSlug}/pulls/${prNumber}/comments --paginate 2>&1`
        .nothrow()
        .quiet(),
      $`gh api repos/${repoSlug}/issues/${prNumber}/comments --paginate 2>&1`
        .nothrow()
        .quiet(),
    ]);

    const threads: PrCommentThread[] = [];

    // Parse review comments (these are file-level, on specific lines)
    if (reviewResult.exitCode === 0) {
      try {
        const reviews: any[] = JSON.parse(reviewResult.stdout.toString());

        // Group review comments by in_reply_to_id to form threads
        const threadMap = new Map<number, any[]>();
        const topLevel: any[] = [];

        for (const c of reviews) {
          if (c.in_reply_to_id) {
            const list = threadMap.get(c.in_reply_to_id) || [];
            list.push(c);
            threadMap.set(c.in_reply_to_id, list);
          } else {
            topLevel.push(c);
          }
        }

        for (const root of topLevel) {
          const replies = threadMap.get(root.id) || [];
          const allComments = [root, ...replies];

          threads.push({
            id: root.id,
            status: root.position != null ? "active" : "unknown",
            filePath: root.path || null,
            line: root.original_line || root.line || null,
            comments: allComments.map((c: any) => ({
              author: c.user?.login || "Unknown",
              content: c.body || "",
              date: c.created_at || "",
            })),
          });
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Parse issue-level comments (general PR comments, not on specific files)
    if (issueResult.exitCode === 0) {
      try {
        const issueComments: any[] = JSON.parse(
          issueResult.stdout.toString(),
        );

        for (const c of issueComments) {
          threads.push({
            id: c.id,
            status: "active",
            filePath: null,
            line: null,
            comments: [
              {
                author: c.user?.login || "Unknown",
                content: c.body || "",
                date: c.created_at || "",
              },
            ],
          });
        }
      } catch {
        // Ignore parse errors
      }
    }

    return threads;
  },
};

// ── Register ────────────────────────────────────────────────────────────────

registerProvider(github);
