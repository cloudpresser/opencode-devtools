/**
 * Defect Workflow — Fix defects linked to existing PRs.
 *
 * Launcher: /fix-defect <defectId> [baseBranch]
 * Worker: receives context via /workflow-run fix-defect <defectId>
 *
 * Replaces the old superior-defect + superior-defect-work commands.
 */

import type {
  WorkflowDefinition,
  ResolveContext,
  ResolveResult,
  WorkerContext,
  WorkerContextResult,
} from "../types";
import type { AfterWriteHandler } from "../types";
import { pushQueueConclusion } from "../conclusions";

// ─── Constants ───────────────────────────────────────────────────────────────

const TESTING_GUIDANCE = `### How to Write Tests in This Project

**If the package has no test setup** (no \`"test"\` script in package.json, no *.test.* files):

Use the \`generate\` tool to scaffold test infrastructure:
\`\`\`
generate(template: "add-tests", name: "<ComponentName>", parent: "<full/package/path>", testType: "view"|"viewmodel"|"model")
\`\`\`
- \`name\`: PascalCase component/class name (e.g. "BreakdownRowView")
- \`parent\`: Full path from repo root (e.g. "packages/features/Overview/breakdown-row/breakdown-row-view")
- \`testType\`: "view" for snapshot/className tests, "viewmodel" for ViewModel unit tests, "model" for Model unit tests

This adds jest config, devDependencies, test script, and a test stub automatically.

**If the package already has tests**, follow the existing patterns in that package.

**DO NOT manually configure babel or jest transforms** — the \`@vectorvest/testing-utils\` preset handles all transform config, react-native mocks, and setup automatically.

**Test patterns:**
- **View (snapshot)**: \`renderer.create(<Component />).toJSON()\` → \`toMatchSnapshot()\`
- **View (className)**: Render → traverse JSON tree → inspect \`className\` props for Tailwind classes
- **ViewModel**: \`new ViewModel(mockModel)\` → assert exposed properties/methods
- **Model**: \`new Model()\` → assert state and behavior
- **ALWAYS** import from \`@jest/globals\`: \`import { describe, expect, it, jest } from '@jest/globals'\`

**Pure TS utility packages (models, ViewModels, non-RN code):**
If the \`add-tests\` generator produces babel/Flow parse errors, the package
likely doesn't need the full RN mock chain. Create a \`jest.config.ts\` manually:
\`\`\`ts
export default {
  clearMocks: true,
  testEnvironment: 'jest-environment-node',
  transformIgnorePatterns: [
    '/node_modules/(?!(@vectorvest|react-native|react-native-.*)/)',
  ],
};
\`\`\`
And in package.json, remove \`"preset": "@vectorvest/testing-utils"\` and
\`"testEnvironment": "jsdom"\` from the jest config. Keep only
\`"scripts": { "test": "jest" }\` and \`"devDependencies": { "@jest/globals": "^29.7.0" }\`.

**Running tests**: \`yarn tensor test <package-name>\` (runs jest scoped to that package)`;

// ─── Resolve (Launcher) ──────────────────────────────────────────────────────

const resolve = async (
  ctx: ResolveContext,
): Promise<ResolveResult | undefined> => {
  if (!ctx.workItemId) return undefined;

  // Fetch the defect
  const { raw: defect } = await ctx.utils.fetchWorkItem(ctx.workItemId);

  // Discover the PR via the shared utility
  const prResult = await ctx.utils.discoverPR(defect);
  if (!prResult) return undefined; // agent fallback

  const { pr } = prResult;
  const parts = ctx.args.split(/\s+/);
  const baseBranch = parts[1] || pr.targetBranch || "staging";

  return {
    branchName: pr.sourceBranch,
    baseBranch,
    workerArgs: ctx.workItemId,
    reuseExisting: true, // PR branch already exists
    sideEffects: async () => {
      // Move defect to In-Progress (best-effort)
      try {
        await ctx.utils
          .$`az boards work-item update --id ${ctx.workItemId} --state In-Progress`
          .quiet()
          .nothrow();
      } catch {
        /* non-fatal */
      }
    },
  };
};

// ─── Worker Context Injection ────────────────────────────────────────────────

const injectWorkerContext = async (
  ctx: WorkerContext,
): Promise<WorkerContextResult> => {
  if (!ctx.workItemId) {
    return {
      userMessage: `Fix defect: ${ctx.args}`,
      templateVars: {
        DEFECT_CONTEXT: "No defect ID provided.",
        PARENT_CONTEXT: "",
        PR_CONTEXT: "",
        PR_COMMENTS: "",
        MEDIA_CONTEXT: "",
        DEFECT_ID: "",
        PR_ID: "",
        TARGET_BRANCH: "staging",
        REMAINING_WORK: "unknown",
        TESTING_GUIDANCE: TESTING_GUIDANCE,
      },
    };
  }

  // Fetch defect
  const { formatted: defectCtx, raw: defect } =
    await ctx.utils.fetchWorkItem(ctx.workItemId);

  // Fetch parent work item
  let parentCtx = "> No parent work item found.";
  const parentRel = defect.relations?.find(
    (r: any) => r.relation === "Parent",
  );
  if (parentRel) {
    try {
      const { formatted } = await ctx.utils.fetchWorkItem(
        String(parentRel.id),
      );
      parentCtx = formatted;
    } catch {
      parentCtx = "> Failed to fetch parent work item.";
    }
  }

  // Discover PR + comments
  let prCtx = "> No linked PR found.";
  let commentsCtx = "> No active PR review threads.";
  let prId = "";
  let targetBranch = "staging";

  const prResult = await ctx.utils.discoverPR(defect);
  if (prResult) {
    prId = prResult.prId;
    targetBranch = prResult.pr.targetBranch || "staging";
    try {
      prCtx = await ctx.utils.formatPR(prId);
    } catch {
      prCtx = `> Failed to fetch PR #${prId}.`;
    }
    try {
      commentsCtx = await ctx.utils.fetchPRComments(prId);
    } catch {
      commentsCtx = "> Failed to fetch PR comments.";
    }
  }

  // Process media from defect fields + attachments
  const media = await ctx.utils.processMedia(
    defect.fields || {},
    defect.attachments,
  );

  // RemainingWork
  const remaining =
    defect.fields?.["Microsoft.VSTS.Scheduling.RemainingWork"];
  // RemainingWork is stored in work days — convert to hours (1 day = 8h)
  const remainingStr =
    remaining != null ? String(Number(remaining) * 8) : "unknown";

  return {
    userMessage: ctx.utils.generateUserMessage(
      "fix-defect",
      defect,
      ctx.workItemId,
      ctx.args,
    ),
    templateVars: {
      DEFECT_CONTEXT: defectCtx,
      PARENT_CONTEXT: parentCtx,
      PR_CONTEXT: prCtx,
      PR_COMMENTS: commentsCtx,
      MEDIA_CONTEXT: media,
      DEFECT_ID: ctx.workItemId,
      PR_ID: prId,
      TARGET_BRANCH: targetBranch,
      REMAINING_WORK: remainingStr,
      TESTING_GUIDANCE: TESTING_GUIDANCE,
    },
  };
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

// ─── After-Write Hook ────────────────────────────────────────────────────────

const afterWriteTypeCheckAndTest: AfterWriteHandler = async (ctx) => {
  const tsFiles = ctx.filePaths.filter((f) => /\.[tj]sx?$/.test(f));
  if (tsFiles.length === 0) return undefined;

  const results: string[] = [];

  // 1. Type check
  try {
    const typeCheck = await ctx.utils
      .$`yarn check-types 2>&1`
      .nothrow()
      .quiet();
    if (typeCheck.exitCode !== 0) {
      const output = (
        typeCheck.stdout?.toString() ||
        typeCheck.stderr?.toString() ||
        ""
      ).trim();
      const lines = output.split("\n").slice(0, 25).join("\n");
      results.push(`\n--- TYPE CHECK: ERRORS FOUND ---\n${lines}`);
    } else {
      results.push(`\n--- TYPE CHECK: PASSED ---`);
    }
  } catch {
    /* non-fatal */
  }

  // 2. Run tests for affected packages (let lerna resolve from HEAD)
  try {
    const testResult = await ctx.utils
      .$`yarn test 2>&1`
      .nothrow()
      .quiet()
      .timeout(300_000); // 5 minutes

    const output = (
      testResult.stdout?.toString() ||
      testResult.stderr?.toString() ||
      ""
    ).trim();

    if (testResult.exitCode !== 0) {
      const lines = output.split("\n").slice(-30).join("\n");
      results.push(`\n--- TESTS: FAILING ---\n${lines}`);
    } else if (!output || output.includes("No packages")) {
      results.push(`\n--- TESTS: No affected packages found ---`);
    } else {
      // Extract summary from lerna output
      const summaryLine =
        output.split("\n").find((l: string) => l.includes("lerna success")) ||
        "All tests passed";
      results.push(`\n--- TESTS: PASSED (${summaryLine.trim()}) ---`);
    }
  } catch (e: any) {
    if (e.message?.includes("timeout")) {
      results.push(`\n--- TESTS: TIMED OUT (5 min limit) ---`);
    }
    /* else non-fatal */
  }

  return results.length > 0 ? results.join("\n") : undefined;
};

// ─── Workflow Definition ─────────────────────────────────────────────────────

export const defectWorkflow: WorkflowDefinition = {
  name: "fix-defect",
  description: "Fix a defect linked to an existing PR",
  requiredTools: ["work-item", "get-pr", "pr-comments", "generate"],
  workerTemplate: "worker.md",
  launcherTemplate: "launcher.md",
  usesWorktree: true,
  resolve,
  injectWorkerContext,
  conclusion: pushQueueConclusion,
  injectAfterWrite: [afterWriteTypeCheckAndTest],
  agent: {
    name: "defect-worker",
    model: "opencode/claude-opus-4-6",
    mode: "all",
    description:
      "Autonomous worker for fixing defects in isolated worktrees",
    disabledTools: [
      "work-item",
      "work-item-comment",
      "create-pr",
      "get-pr",
      "pr-comments",
      "push-queue-logs",
      "push-queue-jobs",
      "create-worktree",
      "remove-worktree",
      "build-status",
      "session-analysis",
    ],
    permissions: ["external_directory", "doom_loop"],
  },
  __dirname: import.meta.dir,
};
