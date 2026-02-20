import type { Provider } from "./types";

// ─── Provider Registry ───────────────────────────────────────────────────────
// Providers self-register at import time. The registry is the single source of
// truth for available provider names — nothing is hardcoded in config schemas.

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  if (providers.has(provider.name)) {
    throw new Error(
      `[devtools] Provider "${provider.name}" is already registered`,
    );
  }
  providers.set(provider.name, provider);
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    const available = [...providers.keys()].join(", ") || "(none)";
    throw new Error(
      `[devtools] Unknown provider "${name}". Available: ${available}`,
    );
  }
  return provider;
}

export function getProviderNames(): string[] {
  return [...providers.keys()];
}
