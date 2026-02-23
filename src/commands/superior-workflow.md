You are executing the Superior Workflow for planning and task breakdown.

## Work Item Context (auto-fetched)

{{WORK_ITEM_CONTEXT}}

## Your Mission

Break down this work item into actionable dev sub-tasks on the Azure
DevOps board, following the Superior team's sprint process end-to-end.

## Phase 1: Understand the Work Item

The work item details above were auto-fetched. Analyze:

- Type (User Story, Bug), acceptance criteria, repro steps
- Existing children (spike, QA, test cases, dev tasks)
- Current state and assignment

If you need more details about a child work item, use the `work-item`
tool to fetch it.

## Phase 2: Spike / Research (if needed)

**Create a spike when:** the work item is unclear, root cause is
unknown, or you don't know what dev tasks are needed.

**Skip when:** implementation path is obvious and well-defined.

If spiking:

1. Use sub-agents to explore the codebase thoroughly
2. Identify root causes with exact file paths and line numbers
3. Map the impact scope (files, packages, dependencies)
4. Update the spike task with findings and close it:

```bash
az boards work-item update --id <SPIKE_ID> \
  --state "Closed" \
  --description '<h3>Spike Conclusions</h3>
  <h4>Root Causes / Findings:</h4>
  <ol>
  <li><b>Finding 1</b> — <code>file.ts:line</code> description</li>
  </ol>'
```

Spike conclusions MUST include:

- Root causes with exact file paths and line numbers
- Affected components and their relationships
- Proposed fix approach for each root cause
- Any risks or dependencies identified

## Phase 3: Create Dev Sub-Tasks

### Rules (mandatory)

| Rule              | Detail                                   |
| ----------------- | ---------------------------------------- |
| Max duration      | 1 business day per task                  |
| Deliverable       | Each task produces a mergeable PR        |
| One PR per task   | Do not bundle multiple tasks into one PR |
| Required fields   | Assigned to, remaining work (hours)      |
| Red/green testing | MANDATORY — failing test first, then fix |
| Max in-progress   | 2 sub-tasks at any given time            |
| Completion        | Closed only after PR review is approved  |

### Task description template

Every dev task description MUST contain all context to execute
without re-reading the spike or parent:

```html
<h3>Dev: <title></h3>
<p><b>Branch:</b> <code><prefix>/<parent-id>-<desc></code>
  (from <code><base-branch></code>)<br/>
<b>PR Target:</b> <code>staging</code><br/>
<b>Estimated:</b> X day(s)</p>

<h4>Problem</h4>
<p>What's wrong, with exact file paths and line numbers.</p>

<h4>Approach</h4>
<p>Step-by-step fix plan.</p>

<h4>Acceptance Criteria</h4>
<ul><li>Specific, testable criteria</li></ul>

<h4>Red/Green Testing</h4>
<ol>
<li><b>Red commit:</b> Write failing test. Commit.</li>
<li><b>Green commit:</b> Implement fix. Commit — test passes.</li>
</ol>

<h4>Files to Modify</h4>
<ul><li><code>path/to/file.ts</code> — what to change</li></ul>

<h4>Dependencies</h4>
<p>Tasks that must complete first (if any).</p>
```

### Creating tasks via Azure CLI

<!-- TODO: Replace az CLI usage with a custom `create-work-item` tool
in opencode-devtools. The tool should accept structured input (title,
description, parent, assigned-to, fields) and handle parent-child
linking automatically. -->

For each task:

```bash
az boards work-item create --type Task \
  --title "Dev: <title>" \
  --assigned-to "<name>" \
  --area "<parent area path>" \
  --iteration "<parent iteration path>" \
  --fields "Microsoft.VSTS.Scheduling.RemainingWork=<hours>" \
  --description '<html description>'
```

Then link to parent:

```bash
az boards work-item relation add \
  --id <TASK_ID> --relation-type parent \
  --target-id <PARENT_ID>
```

## Phase 4: Branching Strategy

**ASK the user** which base branch to use. Do not assume.

### Branch naming

| Work item type | Prefix                      |
| -------------- | --------------------------- |
| User Story     | `dev/<card-id>-<desc>`      |
| Bug            | `bug/<card-id>-<desc>`      |
| Defect         | `defect/<card-id>-<desc>`   |
| Refactor       | `refactor/<card-id>-<desc>` |

### PR target

All PRs target `staging`. If the base branch differs from `staging`,
the base branch must merge to `staging` first for clean diffs.

## Phase 5: Summary

After creating all tasks, present:

- Table of all children (ID, state, title, assigned)
- Execution order with dependencies noted
- Branching diagram showing base → branches → PR target

## Azure DevOps CLI Quick Reference

```bash
# Show work item
az boards work-item show --id <ID> -o json

# Create task
az boards work-item create --type Task --title "..." --assigned-to "..."

# Link child to parent
az boards work-item relation add --id <CHILD> --relation-type parent --target-id <PARENT>

# Update state
az boards work-item update --id <ID> --state "<State>"

# Close with description
az boards work-item update --id <ID> --state "Closed" --description '<html>'
```
