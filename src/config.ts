import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import stripJsonComments from "strip-json-comments";

// ─── Server Config Schema ────────────────────────────────────────────────────

const ReadyPatternSchema = z
  .array(z.string())
  .describe("Regex patterns that indicate the server is ready");

const ServerConfigSchema = z.object({
  cwd: z.string().describe("Working directory relative to project root"),
  command: z.string().default("yarn"),
  args: z.array(z.string()).describe("Command arguments"),
  title: z.string().describe("Display title for this server"),
  portFlag: z.string().describe("CLI flag for port assignment"),
  defaultPort: z.number().describe("Default port number"),
  readyPatterns: ReadyPatternSchema.optional(),
  bundleId: z
    .string()
    .optional()
    .describe("App bundle ID (e.g. for iOS simulator)"),
});

// ─── Tool-specific Config Schemas ────────────────────────────────────────────

const DevServerConfigSchema = z.object({
  servers: z
    .record(z.string(), ServerConfigSchema)
    .describe("Named server configurations"),
  readyTimeout: z
    .number()
    .default(180)
    .describe("Seconds to wait for server readiness"),
  pollInterval: z
    .number()
    .default(1)
    .describe("Seconds between readiness polls"),
  portScanRange: z
    .number()
    .default(20)
    .describe("Number of ports to scan for availability"),
  errorPatterns: z
    .array(z.string())
    .optional()
    .describe("Regex patterns indicating server errors"),
});

const ServerLogsConfigSchema = z.object({
  defaultLineCount: z.number().default(100),
});

const CheckTypesConfigSchema = z.object({
  command: z.string().default("yarn"),
  args: z.array(z.string()).default(["check-types"]),
  branchCommand: z
    .string()
    .optional()
    .describe("Command for branch-only type checking"),
  branchArgs: z.array(z.string()).optional(),
  maxErrors: z.number().default(100),
  maxLines: z.number().default(200),
});

const LintConfigSchema = z.object({
  command: z.string().default("yarn"),
  args: z.array(z.string()).default(["lint"]),
  maxLines: z.number().default(200),
});

const GenerateConfigSchema = z.object({
  command: z.string().default("yarn"),
  args: z.array(z.string()).default(["generate", "--non-interactive"]),
  templates: z
    .array(z.string())
    .optional()
    .describe("Available template names for description"),
});

const CreatePrConfigSchema = z.object({
  command: z.string().default("bunx"),
  args: z.array(z.string()).default(["@cloudpresser/create-pr"]),
  timeout: z.number().default(180).describe("Timeout in seconds"),
  urlPattern: z
    .string()
    .optional()
    .describe("Regex to extract PR URL from output"),
});

const RunTestsConfigSchema = z.object({
  command: z.string().default("yarn"),
  args: z.array(z.string()).default(["test"]),
});

const BuildStatusConfigSchema = z.object({
  provider: z.enum(["azure-devops"]).default("azure-devops"),
  command: z.string().default("az"),
  args: z.array(z.string()).default(["pipelines", "runs", "list"]),
  topBuilds: z.number().default(3),
  watchInterval: z
    .number()
    .default(30)
    .describe("Seconds between polls in watch mode"),
  defaultBranch: z.string().default("main"),
});

// ─── Tool Enable/Disable ─────────────────────────────────────────────────────

const ToolsEnabledSchema = z.object({
  "dev-server": z.boolean().default(true),
  "server-logs": z.boolean().default(true),
  "check-types": z.boolean().default(true),
  lint: z.boolean().default(true),
  generate: z.boolean().default(false),
  "create-pr": z.boolean().default(false),
  "run-tests": z.boolean().default(true),
  "build-status": z.boolean().default(false),
});

// ─── Root Config Schema ──────────────────────────────────────────────────────

// Default values for the root config — provided explicitly so TypeScript
// can verify the literal types against each sub-schema.

export const DEFAULT_TOOLS_ENABLED = {
  "dev-server": true,
  "server-logs": true,
  "check-types": true,
  lint: true,
  generate: false,
  "create-pr": false,
  "run-tests": true,
  "build-status": false,
} as const satisfies z.input<typeof ToolsEnabledSchema>;

const DEFAULT_DEV_SERVER = {
  servers: {
    expo: {
      cwd: "apps/mobile",
      command: "yarn",
      args: ["dev", "--ios"],
      title: "Expo Dev Server",
      portFlag: "--port",
      defaultPort: 8081,
      readyPatterns: ["iOS Bundled \\d+ms", "LOG\\s"],
      bundleId: "com.vectorvest.mobile",
    },
    nextjs: {
      cwd: "apps/next",
      command: "yarn",
      args: ["dev"],
      title: "Next.js Dev Server",
      portFlag: "-p",
      defaultPort: 3000,
      readyPatterns: ["Ready in", "✓ Ready"],
    },
  },
  readyTimeout: 180,
  pollInterval: 1,
  portScanRange: 20,
} as const satisfies z.input<typeof DevServerConfigSchema>;

const DEFAULT_SERVER_LOGS = {
  defaultLineCount: 100,
} as const satisfies z.input<typeof ServerLogsConfigSchema>;

const DEFAULT_CHECK_TYPES = {
  command: "yarn",
  args: ["check-types"],
  branchCommand: "bash",
  branchArgs: ["check-branch-types.sh"],
  maxErrors: 100,
  maxLines: 200,
} as const satisfies z.input<typeof CheckTypesConfigSchema>;

const DEFAULT_LINT = {
  command: "yarn",
  args: ["lint"],
  maxLines: 200,
} as const satisfies z.input<typeof LintConfigSchema>;

const DEFAULT_GENERATE = {
  command: "yarn",
  args: ["generate", "--non-interactive"],
  templates: [
    "feature",
    "simple-feature",
    "view",
    "view-model",
    "model",
    "query",
    "mutation",
    "network",
    "context",
    "adr",
    "feature-story",
    "view-story",
    "query-story",
    "mutation-story",
  ],
} as const satisfies z.input<typeof GenerateConfigSchema>;

const DEFAULT_CREATE_PR = {
  command: "bunx",
  args: ["@cloudpresser/create-pr"],
  timeout: 180,
  urlPattern: "https:\\/\\/dev\\.azure\\.com[^\\s)]+",
} as const satisfies z.input<typeof CreatePrConfigSchema>;

const DEFAULT_RUN_TESTS = {
  command: "yarn",
  args: ["test"],
} as const satisfies z.input<typeof RunTestsConfigSchema>;

const DEFAULT_BUILD_STATUS = {
  provider: "azure-devops",
  command: "az",
  args: ["pipelines", "runs", "list"],
  topBuilds: 3,
  watchInterval: 30,
  defaultBranch: "main",
} as const satisfies z.input<typeof BuildStatusConfigSchema>;

// ─── Root Config Schema ──────────────────────────────────────────────────────

export const DevToolsConfigSchema = z.object({
  tools: ToolsEnabledSchema.default(DEFAULT_TOOLS_ENABLED),
  devServer: DevServerConfigSchema.default(DEFAULT_DEV_SERVER),
  serverLogs: ServerLogsConfigSchema.default(DEFAULT_SERVER_LOGS),
  checkTypes: CheckTypesConfigSchema.default(DEFAULT_CHECK_TYPES),
  lint: LintConfigSchema.default(DEFAULT_LINT),
  generate: GenerateConfigSchema.default(DEFAULT_GENERATE),
  createPr: CreatePrConfigSchema.default(DEFAULT_CREATE_PR),
  runTests: RunTestsConfigSchema.default(DEFAULT_RUN_TESTS),
  buildStatus: BuildStatusConfigSchema.default(DEFAULT_BUILD_STATUS),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type DevToolsConfig = z.infer<typeof DevToolsConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ToolsEnabled = z.infer<typeof ToolsEnabledSchema>;

// ─── Tool Metadata ────────────────────────────────────────────────────────────
// Human-readable labels and hints for each tool. Used by the setup CLI.
// TypeScript enforces completeness: adding a tool to DEFAULT_TOOLS_ENABLED
// without a metadata entry causes a compile error.

export type ToolKey = keyof typeof DEFAULT_TOOLS_ENABLED;

export const TOOL_METADATA: Record<
  ToolKey,
  {
    label: string;
    hint: string;
    configKey: keyof Omit<DevToolsConfig, "tools"> | null;
  }
> = {
  "dev-server": {
    label: "Dev Server",
    hint: "Start Expo/Next.js dev servers",
    configKey: "devServer",
  },
  "server-logs": {
    label: "Server Logs",
    hint: "Read logs from running dev servers",
    configKey: "serverLogs",
  },
  "check-types": {
    label: "Check Types",
    hint: "Run TypeScript type checking",
    configKey: "checkTypes",
  },
  lint: {
    label: "Lint",
    hint: "Run the project linter",
    configKey: "lint",
  },
  generate: {
    label: "Generate",
    hint: "Scaffold features, views, models, etc.",
    configKey: "generate",
  },
  "create-pr": {
    label: "Create PR",
    hint: "Create pull requests via CLI",
    configKey: "createPr",
  },
  "run-tests": {
    label: "Run Tests",
    hint: "Execute test suite",
    configKey: "runTests",
  },
  "build-status": {
    label: "Build Status",
    hint: "Monitor CI/CD pipeline status",
    configKey: "buildStatus",
  },
};

// ─── Load Config ─────────────────────────────────────────────────────────────

const CONFIG_FILENAMES = [".devtools.jsonc", ".devtools.json"];

export function loadConfig(directory: string): DevToolsConfig {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(directory, filename);
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        const stripped = stripJsonComments(raw).replace(/,\s*([}\]])/g, "$1"); // strip trailing commas
        const parsed = JSON.parse(stripped);
        return DevToolsConfigSchema.parse(parsed);
      }
    } catch (e) {
      console.error(`[devtools] Failed to load ${configPath}: ${e}`);
    }
  }

  // No config file found — return defaults
  return DevToolsConfigSchema.parse({});
}
