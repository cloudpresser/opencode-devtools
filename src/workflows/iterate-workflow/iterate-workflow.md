You are analyzing a workflow execution and iterating on the workflow
definition to improve it.

## Session: {{SESSION_ID}}

{{SESSION_ANALYSIS}}

## Detected Workflow: `{{WORKFLOW_NAME}}`

### Current Definition (`index.ts`)

```typescript
{{WORKFLOW_DEFINITION}}
```

### Current Worker Template

```markdown
{{WORKFLOW_TEMPLATE}}
```

## Phase 1: Deep Analysis

Analyze the session execution in detail. Start with the summary above,
then use the `session-analysis` tool (with `verbose: true`) to drill
into specific turns where you see issues.

Build a structured assessment covering:

### Effectiveness
- Did the workflow achieve its goal?
- How much of the session was productive vs wasted?
- What was the cost/benefit ratio?

### Tool Usage Patterns
- **Over-used tools**: Called excessively without clear benefit
  (wasted tokens and time)
- **Failed tool calls**: Patterns of repeated failures — is the tool
  misconfigured, or is the template giving bad instructions?
- **Missing tools**: Manual steps (bash commands, complex multi-step
  operations) that a dedicated tool could handle better
- **Unnecessary tools**: Tools that were called but whose output
  wasn't useful for the task

### Output Format Evaluation
- Did tool outputs give the agent the information it needed?
- Were outputs too verbose (wasting context) or too terse (missing
  critical details)?
- Would a restructured output format reduce confusion or improve
  decision-making?

### Context Injection Quality
- Was the injected context sufficient? Did the agent have to
  re-fetch information that should have been pre-injected?
- Was any injected context ignored or irrelevant? (wasted tokens)
- Were there information gaps that caused the agent to go in
  wrong directions?

### Template Clarity
- Did the agent follow the template instructions faithfully?
- Were any instructions ambiguous, leading to wrong interpretations?
- Were phases in the right order? Did the agent skip phases or
  do them out of order?
- Were there missing guardrails that would have prevented mistakes?

### New Tool Opportunities
- Were there patterns in the session where the agent performed
  multi-step manual operations that could be automated?
- Did the agent struggle with a task that a purpose-built tool
  would make trivial?
- If proposing a new tool: describe its interface, what it
  automates, and show evidence from the session that it would help

## Phase 2: Present & Discuss

Present your findings as a structured report. For each finding,
rate its severity:
- **Critical**: Caused task failure or major waste
- **Moderate**: Reduced effectiveness but didn't block progress
- **Minor**: Small improvement opportunity

Then ask the user:
> "What specifically didn't work as expected from your perspective?"

The user may have insights that the session data doesn't reveal.
Discuss their observations before proposing changes.

## Phase 3: Propose Changes

For each identified issue, propose a **specific, concrete change**.
Show before/after for template edits. Be precise about what code
to change in the workflow definition.

Categories of changes:

### Template Changes
- Wording improvements (show the exact text to change)
- Reordered phases
- Added guardrails or constraints
- Removed unnecessary instructions

### Context Injection Changes
- Additional data to fetch in `injectWorkerContext()`
- Data to stop fetching (not useful)
- Different formatting of injected data

### Tool Configuration
- Tools to add to `requiredTools`
- Tools to add to `agent.disabledTools`
- `injectAfterWrite` handlers to add (e.g., auto-run type check
  after edits, auto-run tests)

### Conclusion Strategy
- Different strategy needed?
- Strategy template fragment tweaks?

### New Tool Proposals
- If a new tool would significantly improve the workflow, describe:
  - Name and purpose
  - Input parameters and return value
  - What it automates (with evidence from the session)
  - Note as a follow-up implementation item

Present each change and get user approval before implementing.

## Phase 4: Implement

Apply only the changes the user approved:

1. Edit workflow files in `{{PLUGIN_WORKFLOWS_DIR}}/{{WORKFLOW_NAME}}/`
2. Update tests if behavior changed
3. Run tests: `bun test src/workflows/{{WORKFLOW_NAME}}/`
4. Run type check: `npx tsc --noEmit`

## Phase 5: Verify

Show the diff: `bunx critique@0.1.50 --web`

Summarize what was changed and why, so the user has a clear
record of the iteration.