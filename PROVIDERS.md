# Adding a New Provider

This plugin uses an **adapter pattern** for source-code hosting providers. Each
provider (Azure DevOps, GitHub, etc.) is a self-contained module that
implements a shared `Provider` interface and registers itself at import time.

## Architecture

```
src/providers/
  types.ts        – Provider interface + normalized result types
  registry.ts     – registerProvider / getProvider / getProviderNames
  azure-devops.ts – Azure DevOps adapter (az CLI)
  github.ts       – GitHub adapter (gh CLI)
  index.ts        – barrel re-exports + side-effect imports for registration
```

The registry is a simple `Map<string, Provider>`. Each adapter module calls
`registerProvider(instance)` as a top-level side-effect, so importing the
barrel file (`src/providers/index.ts`) is enough to make every adapter
available.

## Steps to add a provider

### 1. Create `src/providers/<name>.ts`

Implement the `Provider` interface from `types.ts`:

```ts
import type { Provider, RepoInfo, WorkItemResult, BuildRun, CreatePrResult, PrResult } from "./types";
import { registerProvider } from "./registry";

const myProvider: Provider = {
  name: "my-provider",

  async resolveRepo(root, $): Promise<RepoInfo> { ... },
  async fetchWorkItem(ref, config, root, $): Promise<WorkItemResult> { ... },
  async fetchBuildRuns(branch, config, root, $): Promise<BuildRun[]> { ... },
  async createPr(args, config, root, $): Promise<CreatePrResult> { ... },
  async fetchPr(ref, config, root, $): Promise<PrResult> { ... },
};

registerProvider(myProvider);
```

Every method receives:

| Param    | Description                                               |
|----------|-----------------------------------------------------------|
| `root`   | Absolute path to the repository root                      |
| `$`      | `zx` shell instance for running CLI commands              |
| `config` | Full plugin config (typed as `z.infer<typeof ConfigSchema>`) |
| `ref`    | Work-item ID, PR number, or branch name (tool-dependent)  |
| `args`   | (createPr only) `{ title?, body?, draft?, targetBranch? }`|

### 2. Register the import

Add a side-effect import in `src/providers/index.ts`:

```ts
import "./<name>";
```

That's it — the provider is now available in the CLI setup wizard and at
runtime.

### 3. Config

Users select the provider once in their config file:

```json
{
  "provider": "my-provider",
  "tools": { ... }
}
```

The `provider` field is validated at config load time. The CLI setup wizard
(`src/cli.ts`) presents all registered provider names automatically via
`getProviderNames()`.

## Normalized result types

All adapters return the same shapes so tool/presentation code doesn't branch
on the provider. Key types:

- **`WorkItemResult`** — `id, title, type, state, assignedTo, description, url, fields, relations`
- **`BuildRun`** — `id, name, status, branch, url, startedAt?, completedAt?`
- **`CreatePrResult`** — `url, title?, id?`
- **`PrResult`** — `id, title, status, isDraft, sourceBranch, targetBranch, description, url, createdBy, createdDate, mergeStatus, reviewers, policies, workItems, labels, repository?`

`fields` on `WorkItemResult` carries provider-specific raw data (e.g., Azure
DevOps `System.*` fields, GitHub issue JSON) for tools that need it.

Status strings are normalized across providers (`"succeeded"`, `"failed"`,
`"inProgress"`, etc.) so formatting code works uniformly.

## Testing a new provider

1. Set `"provider": "<name>"` in your config file
2. Run the plugin and invoke each tool:
   - `work-item` — fetch a known issue/work-item by ID
   - `build-status` — fetch CI runs for the current branch
   - `create-pr` — create a draft PR
   - `get-pr` — fetch an existing PR by number
3. Verify all normalized fields are populated correctly
