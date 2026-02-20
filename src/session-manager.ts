import { Terminal } from "bun-pty";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PTYSession {
  id: string;
  title: string;
  terminal: Terminal;
  buffer: string[];
  status: "running" | "exited" | "killed";
  exitCode?: number;
  pid: number;
  createdAt: Date;
}

const MAX_BUFFER_LINES = 50_000;

// ─── Session Manager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, PTYSession>();

  spawn(opts: {
    command: string;
    args: string[];
    cwd: string;
    title: string;
    env?: Record<string, string>;
  }): PTYSession {
    const id = `devtools_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const terminal = new Terminal(opts.command, opts.args, {
      cwd: opts.cwd,
      name: "xterm-256color",
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    const session: PTYSession = {
      id,
      title: opts.title,
      terminal,
      buffer: [],
      status: "running",
      pid: terminal.pid,
      createdAt: new Date(),
    };

    terminal.onData((data: string) => {
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.length > 0) {
          session.buffer.push(line);
          if (session.buffer.length > MAX_BUFFER_LINES) {
            session.buffer.shift();
          }
        }
      }
    });

    terminal.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = "exited";
      session.exitCode = exitCode;
    });

    this.sessions.set(id, session);
    return session;
  }

  get(id: string): PTYSession | undefined {
    return this.sessions.get(id);
  }

  findByTitle(title: string): PTYSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.title === title && session.status === "running") {
        return session;
      }
    }
    return undefined;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status === "running") {
      session.terminal.kill();
      session.status = "killed";
    }
    this.sessions.delete(id);
    return true;
  }

  list(): PTYSession[] {
    return Array.from(this.sessions.values());
  }

  readBuffer(
    id: string,
    opts: { offset?: number; limit?: number; pattern?: string },
  ): { lines: string[]; totalLines: number; matchedLines: number } | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    let lines = session.buffer;
    const totalLines = lines.length;

    if (opts.pattern) {
      try {
        const regex = new RegExp(opts.pattern, "i");
        lines = lines.filter((l) => regex.test(l));
      } catch {
        // Invalid regex, return all
      }
    }

    const matchedLines = lines.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 500;
    lines = lines.slice(offset, offset + limit);

    return { lines, totalLines, matchedLines };
  }
}
