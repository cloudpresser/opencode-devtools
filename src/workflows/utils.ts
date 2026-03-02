/**
 * Workflow Utilities — Shared pipelines for all workflows.
 *
 * These eliminate the duplicated fetch→format→inject patterns that were
 * previously copy-pasted across command handlers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DevToolsConfig } from "../config";
import type { WorkItemResult, PrResult } from "../providers/types";
import { getProvider } from "../providers";
import { formatWorkItemResult } from "../tools/work-item";
import { formatPrOutput } from "../tools/get-pr";
import { formatPrComments } from "../tools/pr-comments";
import {
  extractMediaUrls,
  downloadMedia,
  processMedia,
  formatMediaContext,
} from "../tools/media";
import type { WorkflowUtils, WorkflowLogger, WorkerLaunchOpts, WorkerLaunchResult } from "./types";
import { createWorktreeDirect } from "../tools/create-worktree";

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWorkflowUtils(
  config: DevToolsConfig,
  root: string,
  $: any,
  client: any,
  log: WorkflowLogger,
): WorkflowUtils {
  const providerName = config.provider;

  const utils: WorkflowUtils = {
    // ── Properties ──
    provider: providerName,
    $,
    log,
    root,
    config,
    client,

    // ── Fetch & Format Work Item ──
    async fetchWorkItem(id: string) {
      const provider = getProvider(providerName);
      const raw = await provider.fetchWorkItem(id, config.workItem, root, $);
      let formatted = formatWorkItemResult(raw, config.workItem);
      formatted +=
        "\n\n> The work item context above was pre-fetched. " +
        "Do NOT call the `work-item` tool to re-fetch this work item.";
      return { formatted, raw };
    },

    // ── Process Media ──
    async processMedia(fields, attachments) {
      if ((config as any).media?.enabled === false) return "";

      const mediaRefs = extractMediaUrls(fields, attachments);
      if (mediaRefs.length === 0) return "";

      const tmpDir = join(root, ".tmp-media");
      const downloads = await downloadMedia(
        mediaRefs,
        tmpDir,
        $,
        (config as any).media,
      );
      const processed = await processMedia(
        downloads,
        client,
        (config as any).media,
      );
      return formatMediaContext(processed);
    },

    // ── Discover PR ──
    async discoverPR(workItem: WorkItemResult) {
      const provider = getProvider(providerName);
      const prIds = [...(workItem.pullRequestIds || [])];

      // Check parent if no direct PR links
      if (prIds.length === 0) {
        const parentRel = workItem.relations.find(
          (r) => r.relation === "Parent",
        );
        if (parentRel) {
          try {
            const parent = await provider.fetchWorkItem(
              String(parentRel.id),
              config.workItem,
              root,
              $,
            );
            if (parent.pullRequestIds?.length) {
              prIds.push(...parent.pullRequestIds);
            }
          } catch {
            /* parent PR discovery is best-effort */
          }
        }
      }

      if (prIds.length === 0) return undefined;

      // Fetch all PRs in parallel, prefer active
      const prResults = await Promise.all(
        prIds.map(async (id) => {
          try {
            return await provider.fetchPr(
              String(id),
              config.getPr,
              root,
              $,
            );
          } catch {
            return null;
          }
        }),
      );
      const validPrs = prResults.filter(Boolean) as PrResult[];
      const activePr =
        validPrs.find((p) => p.status === "active") || validPrs[0];

      if (!activePr) return undefined;

      return { pr: activePr, prId: String(activePr.id) };
    },

    // ── Format PR ──
    async formatPR(prId: string) {
      const provider = getProvider(providerName);
      const pr = await provider.fetchPr(prId, config.getPr, root, $);
      let formatted = formatPrOutput(pr, config.getPr);
      formatted += "\n\n> Pre-fetched. Do NOT call `get-pr` to re-fetch.";
      return formatted;
    },

    // ── Fetch PR Comments ──
    async fetchPRComments(prId: string) {
      const provider = getProvider(providerName);
      const threads = await provider.fetchPrComments(
        prId,
        config.prComments,
        root,
        $,
      );
      const activeThreads = threads.filter((t) => t.status === "active");
      if (activeThreads.length === 0) return "> No active PR review threads.";

      let formatted = formatPrComments(activeThreads, prId);
      formatted +=
        "\n\n> Pre-fetched. Do NOT call `pr-comments` to re-fetch.";
      return formatted;
    },

    // ── Template Loading ──
    loadTemplate(absolutePath: string) {
      return readFileSync(absolutePath, "utf-8");
    },

    // ── Placeholder Substitution ──
    substitutePlaceholders(template: string, vars: Record<string, string>) {
      let result = template;
      for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, value);
      }
      return result;
    },

    // ── Launch Worker ──
    async launchWorker(opts: WorkerLaunchOpts): Promise<WorkerLaunchResult> {
      return createWorktreeDirect({
        branchName: opts.branchName,
        baseBranch: opts.baseBranch,
        prompt: `${opts.workflowName} ${opts.workerArgs}`,
        workerCommand: `/${opts.workflowName}`,
        workerAgentName: opts.agentName,
        workerAgentModel: opts.agentModel,
        reuseExisting: opts.reuseExisting,
        worktreeRoot: opts.worktreeRoot,
        root,
        $,
        log,
      });
    },

    // ── User Message Generation ──
    generateUserMessage(workflowName, workItemResult, workItemId, rawArgs) {
      if (workItemResult?.id && workItemResult?.title) {
        return `${capitalize(workflowName)} work item #${workItemResult.id}: ${workItemResult.title}`;
      }
      if (workItemId) {
        return `${capitalize(workflowName)} work item #${workItemId}`;
      }
      if (rawArgs) {
        return `${capitalize(workflowName)}: ${rawArgs}`;
      }
      return `Execute the ${workflowName} workflow`;
    },
  };

  return utils;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
