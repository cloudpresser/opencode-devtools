import {
  DEFAULT_TOOLS_ENABLED,
  TOOL_METADATA,
  DevToolsConfigSchema,
  type ToolKey,
} from "./config";
import { getProviderNames } from "./providers";

// ─── Config Generator ─────────────────────────────────────────────────────────
// Generates a .devtools.jsonc string from a set of enabled tool keys.
// Derives everything from the Zod schemas and defaults — no hardcoded values.

const TOOL_KEYS = Object.keys(DEFAULT_TOOLS_ENABLED) as ToolKey[];

/**
 * Indent every line in a string by a given number of spaces.
 */
const indent = (str: string, spaces: number): string =>
  str
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : " ".repeat(spaces) + line))
    .join("\n");

/**
 * Comment out every line with `// ` prefix, preserving relative indentation.
 * Each line is indented 2 spaces (for root object level) then `// ` then content.
 */
const commentOut = (str: string): string =>
  str
    .split("\n")
    .map((line) => (line.trim() === "" ? "  //" : `  // ${line}`))
    .join("\n");

/**
 * Generate a complete .devtools.jsonc config string.
 *
 * - Enabled tools: full defaults emitted as active JSONC
 * - Disabled tools: full defaults emitted as commented-out JSONC
 * - All values derived from DevToolsConfigSchema.parse({})
 */
export const generateConfig = (
  enabledTools: Set<string>,
  provider: string = "azure-devops",
): string => {
  const defaults = DevToolsConfigSchema.parse({ provider });
  const lines: string[] = ["{"];

  // ── Provider field ──
  const providerNames = getProviderNames();
  lines.push(`  // Source control provider: ${providerNames.join(" | ")}`);
  lines.push(`  "provider": "${provider}",`);
  lines.push("");

  // ── Tools section ──
  lines.push("  // Enable/disable tools");
  const toolsObj: Record<string, boolean> = {};
  for (const key of TOOL_KEYS) {
    toolsObj[key] = enabledTools.has(key);
  }
  const toolsJson = JSON.stringify(toolsObj, null, 2);
  lines.push(`  "tools": ${indent(toolsJson, 2).trimStart()},`);

  // ── Per-tool config sections ──
  const toolsWithConfig = TOOL_KEYS.filter(
    (key) => TOOL_METADATA[key].configKey,
  );

  for (let i = 0; i < toolsWithConfig.length; i++) {
    const key = toolsWithConfig[i];
    const meta = TOOL_METADATA[key];
    const configKey = meta.configKey!;
    const value = defaults[configKey];
    const enabled = enabledTools.has(key);
    const isLast = i === toolsWithConfig.length - 1;
    const valueJson = JSON.stringify(value, null, 2);
    const trailingComma = isLast ? "" : ",";

    lines.push("");

    if (enabled) {
      lines.push(`  // ${meta.label} — ${meta.hint}`);
      lines.push(
        `  "${configKey}": ${indent(valueJson, 2).trimStart()}${trailingComma}`,
      );
    } else {
      lines.push(`  // [disabled] ${meta.label} — ${meta.hint}`);
      const block = `"${configKey}": ${valueJson}${trailingComma}`;
      lines.push(commentOut(block));
    }
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
};
