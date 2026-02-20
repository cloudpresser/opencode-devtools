// ─── ANSI Strip ──────────────────────────────────────────────────────────────

export const stripAnsi = (str: string): string =>
  str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
    "",
  );

// ─── Error Filter ────────────────────────────────────────────────────────────

export const ERROR_FILTER =
  /\b(error|Error|ERROR|FAIL|fail|Failed|failed|Warning|WARN|TypeError|SyntaxError|ReferenceError|RangeError|Invariant Violation|BUNDLE|Unable to resolve|Module not found|Failed to compile|Build Error)\b/;

// ─── Port Helpers ────────────────────────────────────────────────────────────

export async function findAvailablePort(
  startPort: number,
  range: number = 20,
): Promise<number> {
  for (let p = startPort; p < startPort + range; p++) {
    try {
      const result = await Bun.$`lsof -ti :${p} 2>/dev/null`
        .quiet()
        .text();
      if (!result.trim()) return p; // Port is free
    } catch {
      return p; // lsof failed = port is free
    }
  }
  return startPort; // Fallback
}

export async function killProcessOnPort(port: number): Promise<void> {
  try {
    const pids = (
      await Bun.$`lsof -ti :${port} 2>/dev/null`.quiet().text()
    ).trim();
    if (pids) {
      await Bun.$`kill -9 ${pids} 2>/dev/null || true`.quiet();
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // Ignore
  }
}
