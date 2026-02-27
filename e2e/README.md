# E2E Tests

End-to-end tests for the opencode-devtools plugin. These tests verify the full
integration of commands, tools, and providers against real (or simulated)
services.

## Structure

```
e2e/
  helpers.ts          - Shared test utilities (spawn OpenCode, parse output)
  superior-defect.e2e.ts  - /superior-defect command e2e tests
```

## Running

```bash
# Run all e2e tests
bun test e2e/

# Run a specific e2e test
bun test e2e/superior-defect.e2e.ts

# Run with Azure DevOps integration (requires az CLI auth)
DEVTOOLS_E2E_LIVE=1 bun test e2e/
```

## Environment

- `DEVTOOLS_E2E_LIVE=1` — Enable tests that hit real Azure DevOps APIs
- `DEVTOOLS_E2E_WORKITEM=71405` — Override the test defect work item ID
- `DEVTOOLS_E2E_ORG=https://dev.azure.com/VectorVest` — Override the org URL
