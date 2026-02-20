#!/usr/bin/env bun

import {
  intro,
  outro,
  multiselect,
  confirm,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import stripJsonComments from "strip-json-comments";
import { DEFAULT_TOOLS_ENABLED, TOOL_METADATA, type ToolKey } from "./config";
import { generateConfig } from "./config-generator";

const CONFIG_FILE = ".devtools.jsonc";
const TOOL_KEYS = Object.keys(DEFAULT_TOOLS_ENABLED) as ToolKey[];

/**
 * Try to read an existing config file and extract currently enabled tools.
 */
const readExistingConfig = (configPath: string): Set<string> | null => {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const stripped = stripJsonComments(raw).replace(/,\s*([\]}])/g, "$1");
    const parsed = JSON.parse(stripped);
    if (!parsed.tools) return null;
    return new Set(
      Object.entries(parsed.tools)
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    );
  } catch {
    return null;
  }
};

const run = async () => {
  intro("opencode-devtools setup");

  const configPath = join(process.cwd(), CONFIG_FILE);
  const existing = readExistingConfig(configPath);

  // ── Overwrite check ──
  if (existing) {
    const overwrite = await confirm({
      message: `${CONFIG_FILE} already exists. Overwrite?`,
    });
    if (isCancel(overwrite) || !overwrite) {
      cancel("Setup cancelled.");
      process.exit(0);
    }
  }

  // ── Tool selection ──
  const initialValues = TOOL_KEYS.filter((key) =>
    existing ? existing.has(key) : DEFAULT_TOOLS_ENABLED[key],
  );

  const selected = await multiselect({
    message: "Select tools to enable:",
    options: TOOL_KEYS.map((key) => ({
      value: key,
      label: TOOL_METADATA[key].label,
      hint: TOOL_METADATA[key].hint,
    })),
    initialValues,
  });

  if (isCancel(selected)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }

  const enabledTools = new Set(selected as string[]);

  // ── Generate and write config ──
  const config = generateConfig(enabledTools);
  writeFileSync(configPath, config, "utf-8");

  const enabledCount = enabledTools.size;
  const disabledCount = TOOL_KEYS.length - enabledCount;

  log.success(
    `${enabledCount} tools enabled, ${disabledCount} disabled (commented out)`,
  );

  outro(
    `Config written to ${CONFIG_FILE}. Customize settings by editing the file directly.`,
  );
};

run().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
