import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./types.js";
import type { ActivityStore } from "./events.js";
import type { PathGuard } from "./paths.js";
import { limitText } from "./utils.js";

interface Session {
  id: string;
  command: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  startedAt: string;
  exitCode?: number;
  finishedAt?: string;
  pendingChunks: Set<Promise<void>>;
}

export interface TerminalChunk {
  sessionId: string;
  command: string;
  cwd: string;
  stream: "stdout" | "stderr";
  text: string;
  output: string;
  startedAt: string;
}

type TerminalChunkHandler = (chunk: TerminalChunk) => void | Promise<void>;

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly config: AppConfig,
    private readonly paths: PathGuard,
    private readonly events: ActivityStore,
  ) {}

  async run(input: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    onChunk?: TerminalChunkHandler;
  }): Promise<{
    sessionId: string;
    command: string;
    cwd: string;
    status: "running" | "completed" | "failed";
    output: string;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number;
  }> {
    const session = await this.start(input);
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? this.config.commandTimeoutMs, 1_000),
      60 * 60 * 1000,
    );
    const result = await new Promise<Session>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.process.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      session.process.once("close", () => {
        clearTimeout(timeout);
        resolve(session);
      });
      session.process.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await Promise.allSettled([...result.pendingChunks]);
    return {
      sessionId: result.id,
      command: result.command,
      cwd: result.cwd,
      status: result.exitCode === 0 ? "completed" : "failed",
      output: limitText(result.output, 250_000),
      startedAt: result.startedAt,
      ...(result.finishedAt === undefined ? {} : { finishedAt: result.finishedAt }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    };
  }

  async start(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    onChunk?: TerminalChunkHandler;
  }): Promise<Session> {
    const cwd = await this.paths.workspace(input.cwd);
    const child = spawn(process.env.SHELL || "/bin/zsh", ["-lc", input.command], {
      cwd,
      env: { ...process.env, ...input.env, OMNIX_GO: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    const session: Session = {
      id: randomUUID(),
      command: input.command,
      cwd,
      process: child,
      output: "",
      startedAt: new Date().toISOString(),
      pendingChunks: new Set(),
    };
    this.sessions.set(session.id, session);
    this.events.publish("terminal", "Command started", "running", input.command, {
      sessionId: session.id,
      cwd,
      pid: child.pid,
    });
    const append = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      session.output = limitText(session.output + text, 2_000_000);
      if (input.onChunk) {
        const pending = Promise.resolve(
          input.onChunk({
            sessionId: session.id,
            command: session.command,
            cwd: session.cwd,
            stream,
            text,
            output: limitText(session.output, 250_000),
            startedAt: session.startedAt,
          }),
        ).catch((error) => {
          this.events.publish(
            "terminal",
            "Progress notification failed",
            "warning",
            String(error),
            { sessionId: session.id },
          );
        });
        session.pendingChunks.add(pending);
        void pending.finally(() => session.pendingChunks.delete(pending));
      }
      this.events.publish("terminal", stream, "info", text, {
        sessionId: session.id,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.once("close", (code) => {
      session.exitCode = code ?? -1;
      session.finishedAt = new Date().toISOString();
      this.events.publish(
        "terminal",
        "Command finished",
        code === 0 ? "success" : "error",
        `${input.command} (exit ${code ?? -1})`,
        { sessionId: session.id },
      );
    });
    return session;
  }

  get(sessionId: string): {
    id: string;
    command: string;
    cwd: string;
    output: string;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number;
    running: boolean;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown terminal session: ${sessionId}`);
    return {
      id: session.id,
      command: session.command,
      cwd: session.cwd,
      output: limitText(session.output, 250_000),
      startedAt: session.startedAt,
      ...(session.finishedAt === undefined ? {} : { finishedAt: session.finishedAt }),
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      running: session.exitCode === undefined,
    };
  }

  list(): ReturnType<TerminalManager["get"]>[] {
    return [...this.sessions.keys()].map((id) => this.get(id));
  }

  write(sessionId: string, input: string): { written: number } {
    const session = this.sessions.get(sessionId);
    if (!session || session.exitCode !== undefined) {
      throw new Error("Terminal session is not running");
    }
    session.process.stdin.write(input);
    return { written: Buffer.byteLength(input) };
  }

  stop(sessionId: string): { stopped: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session || session.exitCode !== undefined) return { stopped: false };
    session.process.kill("SIGTERM");
    return { stopped: true };
  }
}
