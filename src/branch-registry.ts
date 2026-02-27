/**
 * Branch Registry — Persistent mapping of work item IDs to branch names.
 *
 * Stored at ~/.local/share/opencode-devtools/branch-registry.json.
 * Used by workflows to discover which branch a work item is associated
 * with, enabling automatic PR targeting without relying on Azure DevOps
 * PR link discovery.
 *
 * Written by:
 * - `register-branch` tool (plan agent creates feature/bug branches)
 * - implement/fix-defect resolve functions (register dev/ branches)
 *
 * Read by:
 * - fix-defect resolve (looks up parent work item's branch)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const REGISTRY_DIR = join(homedir(), ".local", "share", "opencode-devtools");
const REGISTRY_FILE = join(REGISTRY_DIR, "branch-registry.json");

export interface BranchEntry {
  /** Branch name, e.g. "feature/70000-add-dark-mode" or "dev/70001-add-toggle" */
  branch: string;
  /** What this branch targets, e.g. "staging" or "feature/70000-add-dark-mode" */
  targetBranch: string;
  /** Which workflow created this entry */
  workflow: string;
  /** ISO timestamp of creation */
  createdAt: string;
}

type Registry = Record<string, BranchEntry>;

function load(): Registry {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(registry: Registry): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/** Get a branch registry entry by work item ID. */
export function getEntry(workItemId: string): BranchEntry | undefined {
  return load()[workItemId];
}

/** Set (create or overwrite) a branch registry entry. */
export function setEntry(workItemId: string, entry: BranchEntry): void {
  const registry = load();
  registry[workItemId] = entry;
  save(registry);
}

/** Remove a branch registry entry. */
export function removeEntry(workItemId: string): void {
  const registry = load();
  delete registry[workItemId];
  save(registry);
}

/** Get all registry entries. */
export function getAllEntries(): Registry {
  return load();
}
