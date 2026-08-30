/**
 * Minimal JSONL client for `pi --mode rpc`.
 *
 * Hand-rolled on purpose: pi's RPC framing is strictly LF-delimited JSON
 * (one object per line, both directions) and Node's `readline` cannot be used —
 * it also splits on U+2028/U+2029, which would corrupt any message containing
 * those characters. See docs/design-rpc-surface-panes.md.
 *
 * The client is transport-only: it knows nothing about subagents. Correlation,
 * prompt queues, and exit nudging live in rpc.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** The surface-facing subset of RpcClient. Injectable so rpc.ts is testable. */
export interface RpcTransport {
  /** Fire-and-forget a command. Swallows write errors after the child died (normal race). */
  send(command: Record<string, unknown>): void;
  /** Terminate the child process (group). */
  close(): void;
  /** True once the child process has exited. */
  readonly exited: boolean;
  /** The child's exit code, or null while it is still running. */
  readonly exitCode: number | null;
  /** Subscribe to non-response events (agent_start, message_end, …). Returns an unsubscribe. */
  onEvent(handler: (event: any) => void): () => void;
  /** Subscribe to `response` messages only. Returns an unsubscribe. */
  onResponse(handler: (response: any) => void): () => void;
  /** Called with the exit code when the child exits. Returns an unsubscribe. */
  onExit(handler: (code: number | null) => void): () => void;
}

export interface RpcSpawnOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export class RpcClient implements RpcTransport {
  readonly child: ChildProcess;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private pending = new Map<string, (response: any) => void>();
  private eventHandlers = new Set<(event: any) => void>();
  private responseHandlers = new Set<(response: any) => void>();
  private exitHandlers = new Set<(code: number | null) => void>();
  exited = false;
  exitCode: number | null = null;

  constructor(child: ChildProcess) {
    this.child = child;

    // EPIPE on stdin writes after the child exits is a normal race, not an
    // error — without a listener it would crash the parent extension process.
    child.stdin?.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawn failure (ENOENT/EACCES — the pi binary could not be started).
      // 'error' fires before 'close', so surfacing it as a synthetic event
      // lets the surface record the cause before the exit is observed; the
      // alternative (close with code -2) says nothing about what failed.
      this.emit({
        type: "__spawn_error",
        message: `failed to start "${child.spawnfile ?? "child"}": ${err.code ?? ""} ${err.message}`.trim(),
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdoutChunk(chunk));

    // Child stderr never appears on the RPC channel. Route each line through
    // the event stream as a synthetic "__stderr" event so consumers (rpc.ts)
    // can show it in the transcript — headless children have no pane where
    // stderr would otherwise be visible.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.handleStderrChunk(chunk));

    child.on("close", (code) => {
      this.exited = true;
      this.exitCode = code;
      // A crashing child's last stderr line is often the crash reason and may
      // lack a trailing newline (e.g. `process.stderr.write("fatal: …")`).
      // Flush the tail, like pi's own JSONL reader does — headless children
      // have no pane, so this transcript is the only place it can appear.
      if (this.stderrBuffer.trim() !== "") {
        this.emit({ type: "__stderr", line: this.stderrBuffer.trimEnd() });
        this.stderrBuffer = "";
      }
      // Fail any still-pending requests so awaiters do not hang forever.
      for (const resolve of this.pending.values()) {
        resolve({ type: "response", success: false, error: "child exited" });
      }
      this.pending.clear();
      for (const handler of this.exitHandlers) handler(code);
    });
  }

  /**
   * Spawn a command as an RPC child. `detached: true` starts a new process
   * group so closeSurface can take down the whole tree (the child's bash tool
   * runs its own grandchildren), matching what tmux kill-pane does.
   */
  static spawn(
    command: string,
    args: string[],
    options: RpcSpawnOptions = {},
  ): RpcClient {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env as Record<string, string | undefined>,
      cwd: options.cwd,
      detached: true,
    });
    return new RpcClient(child);
  }

  /** Send a JSON object as one LF-terminated line. */
  send(command: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(command) + "\n");
    } catch {
      // EPIPE race — the child died between the writable check and the write.
    }
  }

  /**
   * Send a command with an auto-assigned `id` and resolve when the matching
   * response arrives. Note that on pi ≥ 0.57 a `prompt` response may arrive
   * immediately, before the agent run — a resolved request is NOT a finished
   * run. Never used for control flow, only for informational commands.
   */
  request(command: Record<string, unknown>): Promise<any> {
    const id = `rpc-${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, ...command });
    });
  }

  onEvent(handler: (event: any) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onResponse(handler: (response: any) => void): () => void {
    this.responseHandlers.add(handler);
    return () => this.responseHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Terminate the child's process group (TERM, then KILL). */
  close(): void {
    if (this.exited) return;
    const pid = this.child.pid;
    try {
      this.child.stdin?.end();
    } catch {}
    try {
      if (pid != null && pid > 0) {
        // Negative pid = the whole process group (detached spawn).
        process.kill(-pid, "SIGTERM");
        const killer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 3000);
        this.child.once("close", () => clearTimeout(killer));
      } else {
        this.child.kill("SIGTERM");
      }
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {}
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    // LF-only framing. Deliberately NOT using Node readline, which also
    // splits on U+2028/U+2029 line separators that appear inside JSON strings.
    for (;;) {
      const idx = this.stdoutBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.trim() === "") continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // Non-JSON line on stdout — ignore defensively rather than crash.
        continue;
      }
      this.dispatch(message);
    }
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const idx = this.stderrBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.stderrBuffer.slice(0, idx);
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line.trim() !== "") this.emit({ type: "__stderr", line: line.trimEnd() });
    }
  }

  private dispatch(message: any): void {
    if (message?.type === "response" && message.id != null) {
      const resolve = this.pending.get(String(message.id));
      if (resolve) {
        this.pending.delete(String(message.id));
        resolve(message);
      }
      for (const handler of this.responseHandlers) handler(message);
      return;
    }
    this.emit(message);
  }

  private emit(message: any): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(message);
      } catch {
        // A broken consumer must not kill the reader loop.
      }
    }
  }
}