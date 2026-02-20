import { tool } from "@opencode-ai/plugin";
import path from "node:path";
import type { DevToolsConfig } from "../config";
import type { SessionManager } from "../session-manager";
import { stripAnsi, findAvailablePort, killProcessOnPort } from "../utils";

export function createDevServerTool(
  config: DevToolsConfig,
  manager: SessionManager,
  root: string,
) {
  const serverNames = Object.keys(config.devServer.servers);

  return ["dev-server_start", tool({
    description:
      "Start a development server. " +
      "If a server of the same type is already running, returns its info instead of spawning a new one. " +
      "Automatically finds an available port if the default is in use. " +
      "Multiple agents share the same server instance." +
      (serverNames.length > 0
        ? ` Available servers: ${serverNames.join(", ")}.`
        : ""),
    args: {
      server: tool.schema.enum(serverNames as [string, ...string[]]),
      port: tool.schema.optional(tool.schema.number()),
    },
    async execute(args) {
      const serverConfig = config.devServer.servers[args.server];
      if (!serverConfig) {
        return `Unknown server "${args.server}". Available: ${serverNames.join(", ")}`;
      }

      const cfg = {
        cwd: path.join(root, serverConfig.cwd),
        command: serverConfig.command,
        args: [...serverConfig.args],
        title: serverConfig.title,
        portFlag: serverConfig.portFlag,
        defaultPort: serverConfig.defaultPort,
      };

      // Check if a server of this type is already running
      const existing = manager.findByTitle(cfg.title);
      if (existing && existing.status === "running") {
        const buf = manager.readBuffer(existing.id, { limit: 50 });
        const lines = buf?.lines ?? [];
        const portMatch = lines
          .join("\n")
          .match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
        const runningPort = portMatch ? portMatch[1] : "unknown";
        return [
          `Server already running (shared session).`,
          `Type: ${cfg.title}`,
          `Port: ${runningPort}`,
          `Session: ${existing.id} (pid: ${existing.pid})`,
          `Use server-logs tool to monitor.`,
        ].join("\n");
      }

      // Kill any dead session for this server type
      if (existing) {
        manager.kill(existing.id);
      }

      const requestedPort = args.port ?? cfg.defaultPort;
      const port = await findAvailablePort(
        requestedPort,
        config.devServer.portScanRange,
      );

      // Kill any existing process on the target port
      await killProcessOnPort(port);

      // If server has a bundleId, terminate it in the simulator
      if (serverConfig.bundleId) {
        try {
          await Bun.$`xcrun simctl terminate booted ${serverConfig.bundleId} 2>/dev/null || true`.quiet();
        } catch {
          // Ignore
        }
      }

      const cmdArgs = [...cfg.args, cfg.portFlag, String(port)];

      const session = manager.spawn({
        command: cfg.command,
        args: cmdArgs,
        cwd: cfg.cwd,
        title: cfg.title,
      });

      // Wait for server to be ready
      const readyPatterns = (serverConfig.readyPatterns ?? []).map(
        (p) => new RegExp(p),
      );
      const errorPatterns = (config.devServer.errorPatterns ?? []).map(
        (p) => new RegExp(p, "i"),
      );

      const TIMEOUT_MS = config.devServer.readyTimeout * 1000;
      const POLL_MS = config.devServer.pollInterval * 1000;
      const startTime = Date.now();
      let ready = false;
      let lastCheckedLine = 0;

      while (Date.now() - startTime < TIMEOUT_MS) {
        if (session.status !== "running") {
          const tail = session.buffer.slice(-20).map(stripAnsi).join("\n");
          return `Server exited unexpectedly (exit code: ${session.exitCode}).\n\n${tail}`;
        }

        const currentLines = session.buffer.length;
        if (currentLines > lastCheckedLine) {
          const newLines = session.buffer
            .slice(lastCheckedLine)
            .map(stripAnsi);

          for (const line of newLines) {
            if (readyPatterns.some((p) => p.test(line))) {
              ready = true;
              break;
            }
          }
          lastCheckedLine = currentLines;
        }

        if (ready) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      // Grab the last meaningful lines
      const recentLines = session.buffer
        .slice(-15)
        .map(stripAnsi)
        .filter((l) => !l.match(/^[▄▀█▓░ ]{5,}$/) && l.trim().length > 0)
        .slice(-5)
        .join("\n");

      if (!ready) {
        return [
          `Server started but readiness not confirmed within ${config.devServer.readyTimeout}s.`,
          `Type: ${cfg.title}`,
          `Port: ${port}`,
          `Session: ${session.id} (pid: ${session.pid})`,
          "",
          "Recent output:",
          recentLines || "(no output)",
          "",
          "Use server-logs tool to investigate.",
        ].join("\n");
      }

      return [
        `Server ready: ${cfg.title}`,
        `Port: ${port}`,
        `Session: ${session.id} (pid: ${session.pid})`,
        "",
        recentLines,
        "",
        "Use server-logs tool to monitor.",
      ].join("\n");
    },
  })] as const;
}
