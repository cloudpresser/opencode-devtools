/**
 * Shared afterWrite hook that runs type-check and tests after every
 * .ts/.tsx file write. Used by both fix-defect and implement workflows.
 *
 * Output is appended to the tool result with `--- TYPE CHECK ---` and
 * `--- TESTS ---` delimiters. The agent should NOT manually re-run
 * these checks — the hook handles them automatically.
 */

import type { AfterWriteHandler } from "../types";

export const afterWriteTypeCheckAndTest: AfterWriteHandler = async (ctx) => {
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

  // 2. Run tests (uses Nx cache — unchanged packages resolve instantly)
  try {
    const testResult = await ctx.utils
      .$`yarn test 2>&1`
      .nothrow()
      .quiet();

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
  } catch {
    /* non-fatal */
  }

  return results.length > 0 ? results.join("\n") : undefined;
};
