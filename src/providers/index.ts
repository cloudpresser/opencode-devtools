// ─── Provider Barrel ──────────────────────────────────────────────────────────
// Importing this module triggers registration of all built-in providers.

export type { Provider, RepoInfo, WorkItemResult, WorkItemRelation, BuildRun, CreatePrResult, PrResult, PrReviewer, PrPolicy, PrWorkItem } from "./types";
export { registerProvider, getProvider, getProviderNames } from "./registry";

// Side-effect imports — each module calls registerProvider() at load time
import "./azure-devops";
import "./github";
