// ─── Normalized Result Types ──────────────────────────────────────────────────
// All providers return these types. Presentation/formatting stays in tool files.

export interface RepoInfo {
  org: string;
  project: string;
}

export interface WorkItemResult {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo: string;
  description: string;
  url: string;
  /** Raw provider-specific fields (Azure DevOps System.* fields, GitHub issue JSON, etc.) */
  fields: Record<string, any>;
  relations: WorkItemRelation[];
}

export interface WorkItemRelation {
  id: number;
  type: string;
  title: string;
  state: string;
  /** Normalized relation label: "Parent", "Child", "Related", etc. */
  relation: string;
}

export interface BuildRun {
  id: string;
  name: string;
  /** Normalized: "succeeded" | "failed" | "inProgress" | "queued" | "cancelled" */
  status: string;
  branch: string;
  url: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreatePrResult {
  url: string;
  title?: string;
  id?: string | number;
}

export interface PrReviewer {
  name: string;
  /** Normalized: "approved" | "approvedWithSuggestions" | "rejected" | "waitingForAuthor" | "none" */
  vote: string;
  isRequired: boolean;
}

export interface PrPolicy {
  name: string;
  /** "build" | "other" */
  type: string;
  /** Normalized: "approved" | "rejected" | "running" | "queued" */
  status: string;
  isBlocking: boolean;
  buildId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PrWorkItem {
  id: string;
  title: string;
  type: string;
  state: string;
}

export interface PrResult {
  id: number | string;
  title: string;
  status: string;
  isDraft: boolean;
  sourceBranch: string;
  targetBranch: string;
  description: string;
  url: string;
  createdBy: string;
  createdDate: string;
  mergeStatus: string;
  reviewers: PrReviewer[];
  policies: PrPolicy[];
  workItems: PrWorkItem[];
  labels: string[];
  repository?: string;
}

export interface PrComment {
  author: string;
  content: string;
  date: string;
}

export interface PrCommentThread {
  id: number | string;
  /** "active" | "fixed" | "closed" | "wontFix" | "byDesign" | "pending" | "unknown" */
  status: string;
  filePath: string | null;
  line: number | null;
  comments: PrComment[];
}

// ─── Provider Interface ──────────────────────────────────────────────────────

export interface Provider {
  readonly name: string;

  resolveRepo(root: string, $: any): Promise<RepoInfo>;

  fetchWorkItem(
    ref: string,
    config: any,
    root: string,
    $: any,
  ): Promise<WorkItemResult>;

  fetchBuildRuns(
    branch: string,
    config: any,
    root: string,
    $: any,
  ): Promise<BuildRun[]>;

  createPr(
    args: {
      title?: string;
      body?: string;
      draft?: boolean;
      targetBranch?: string;
    },
    config: any,
    root: string,
    $: any,
  ): Promise<CreatePrResult>;

  fetchPr(
    ref: string,
    config: any,
    root: string,
    $: any,
  ): Promise<PrResult>;

  fetchPrComments(
    ref: string,
    config: any,
    root: string,
    $: any,
  ): Promise<PrCommentThread[]>;
}
