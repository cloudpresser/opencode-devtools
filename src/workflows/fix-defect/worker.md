You are fixing a defect following the Superior Workflow.

## Defect Context (auto-fetched)

{{DEFECT_CONTEXT}}

### Parent Work Item

{{PARENT_CONTEXT}}

### Pull Request

{{PR_CONTEXT}}

### Active Review Comments

{{PR_COMMENTS}}

{{MEDIA_CONTEXT}}

## Test Infrastructure Reference

{{TESTING_GUIDANCE}}

## Your Mission

Fix this defect. The PR already exists — your commits will be
pushed to the existing branch and update the PR automatically.

### Phase 1: Diagnose

1. Read the defect description and reproduction steps carefully
2. Review the active PR review comments above
3. Examine the relevant code to understand the root cause
4. If the defect includes screenshots or videos, study them
   to understand the expected vs actual behavior

### Phase 2: Test Strategy

Evaluate the defect type and choose the appropriate testing approach:

#### Option A: Unit/Integration Test (DEFAULT — use for logic, structure, and most styling fixes)

1. Check if the target package has test infrastructure:
   - Look for a `"test"` script and `"jest"` config in its `package.json`
   - If missing, see **Test Infrastructure Reference** above to set it up
     using the `generate` tool with the `add-tests` template
2. Write a test that REPRODUCES the defect (must FAIL before the fix):
   - **Jest** for unit / snapshot / className tests
   - **Maestro** (`.yaml`) for E2E / UI interaction behavior
   - ALWAYS import from `@jest/globals`:
     `import { describe, expect, it, jest } from '@jest/globals';`
3. Verify the test fails — check the automatic `--- TESTS ---`
   output after writing the test file. If it shows PASSING, your
   test doesn't reproduce the defect; revise it.
4. Commit using the `commit` tool with `skipHooks: true`:
   - `message`: `test(<scope>): add failing test for defect #{{DEFECT_ID}}`
   - `workdir`: `.`

#### Option B: E2E Screen Verification (ONLY for trivial cosmetic changes)

Use this ONLY when ALL conditions are true:
- The fix is purely cosmetic (single className, spacing, color, font-size)
- No logic, state, data-binding, or interaction behavior changes
- The target package does NOT already have test infrastructure

Even when these conditions are met, **prefer Option A** if the package
already has tests — writing a className assertion is trivial.

Steps for Option B:
1. Check `apps/mobile/.maestro/` for Maestro flows that navigate to the affected screen
2. If the screen IS covered: note which flow covers it, proceed to Phase 3
3. If the screen is NOT covered: write a Maestro `.yaml` flow that
   navigates to the screen and takes a screenshot, then proceed to Phase 3

**For interaction-dependent defects** (tap targets, scroll behavior, animation,
conditional rendering based on user action): ALWAYS use Option A. These
defects cannot be verified visually alone — the test must exercise the
interaction.

### Phase 3: Green Commit (implement fix)

1. Implement the fix
2. After each file write, type-check and test results appear
   automatically in the tool output (look for `--- TYPE CHECK ---`
   and `--- TESTS ---` sections). Review them and fix any errors
   before proceeding. Do NOT manually run check-types, lint, or
   tests — the afterWrite hooks handle this automatically.
3. Once all automatic checks pass, commit using the `commit` tool
   (without `skipHooks`):
   - `message`: `fix(<scope>): <description> (fixes #{{DEFECT_ID}})`
   - `workdir`: `.`

### Phase 4: Session Complete

**Do NOT create a new PR** — the existing PR (#{{PR_ID}}) will be
updated automatically when commits are pushed.
**Do NOT push manually** — the conclusion strategy handles push scheduling.
**Do NOT post work-item comments** — completion comments are posted
automatically after push-queue scheduling.

### If You Cannot Complete the Fix

If blocked or unable to find a confident solution, complete the session
with a summary of your findings and blockers.

## Board Column Movement (Defects)

```
Ready → In-Progress → Ready for Review → (approval) →
  Ready for QA Review → Ready for Staging QA →
  In QA → Staging QA Done → Closed
```