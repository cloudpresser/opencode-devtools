import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(
  homedir(),
  ".local",
  "share",
  "opencode-devtools",
  "logs",
);

type LogLevel = "INFO" | "WARN" | "ERROR";

export interface Logger {
  info(tag: string, message: string): void;
  warn(tag: string, message: string): void;
  error(tag: string, message: string): void;
  /** Return recent log lines, optionally filtered by tag substring */
  getRecent(count?: number, filter?: string): string[];
  /** Absolute path to the current log file */
  readonly logFile: string;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function logFileName(): string {
  const d = new Date();
  return `plugin-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}

/** No-op logger for tests and contexts where logging is not needed */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  getRecent: () => [],
  logFile: "",
};

export function createLogger(): Logger {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best-effort — if we can't create the dir, logging is a no-op
  }

  const logFile = join(LOG_DIR, logFileName());

  function write(level: LogLevel, tag: string, message: string): void {
    try {
      const ts = new Date().toISOString();
      const line = `[${ts}] [${level}] [${tag}] ${message}\n`;
      appendFileSync(logFile, line);
    } catch {
      // Best-effort — never throw from logging
    }
  }

  function getRecent(count = 50, filter?: string): string[] {
    try {
      if (!existsSync(logFile)) return [];
      const content = readFileSync(logFile, "utf-8");
      let lines = content.split("\n").filter(Boolean);
      if (filter) {
        lines = lines.filter((l) => l.includes(filter));
      }
      return lines.slice(-count);
    } catch {
      return [];
    }
  }

  return {
    info: (tag, msg) => write("INFO", tag, msg),
    warn: (tag, msg) => write("WARN", tag, msg),
    error: (tag, msg) => write("ERROR", tag, msg),
    getRecent,
    logFile,
  };
}
