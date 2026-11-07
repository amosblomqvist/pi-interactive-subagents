/**
 * Process-backed subagent surface with private IPC input and file-backed output.
 * It preserves asynchronous execution, steering, status tracking, and result
 * delivery regardless of which terminal hosts the parent Pi session.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { createMailbox, publishMessage, closeMailbox, type InteractiveMessage } from "./interactive-ipc.ts";
import { createHerdrSurface, launchHerdrSurface, herdrMetadata, closeHerdrSurface, waitHerdrAdoption, readHerdrScreen, type HerdrSurface } from "./herdr-surface.ts";

import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.ts";

type BackgroundBashResolutionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  pathMatches?: string[];
};

function findWindowsBashOnPath(): string[] {
  try {
    const output = execFileSync("where.exe", ["bash.exe"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return output.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function isWindowsSystemBash(path: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = win32.normalize(path).toLowerCase();
  const windowsDir = win32.normalize(env.SystemRoot ?? env.WINDIR ?? "C:\\Windows").toLowerCase();
  return normalized === win32.join(windowsDir, "System32", "bash.exe").toLowerCase();
}

/** Resolve a Bash implementation that can execute the generated POSIX scripts. */
export function resolveBackgroundBash(
  options: BackgroundBashResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.exists ?? existsSync;
  const explicit = env.PI_SUBAGENT_BASH?.trim();

  if (explicit) {
    if (pathExists(explicit)) return explicit;
    throw new Error(`PI_SUBAGENT_BASH does not exist: ${explicit}`);
  }

  if (platform !== "win32") return "bash";

  const candidates = [
    env.ProgramFiles ? win32.join(env.ProgramFiles, "Git", "bin", "bash.exe") : null,
    env.ProgramW6432 ? win32.join(env.ProgramW6432, "Git", "bin", "bash.exe") : null,
    env["ProgramFiles(x86)"]
      ? win32.join(env["ProgramFiles(x86)"]!, "Git", "bin", "bash.exe")
      : null,
    env.LOCALAPPDATA
      ? win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : null,
    ...(options.pathMatches ?? findWindowsBashOnPath()),
  ];

  for (const candidate of candidates) {
    if (!candidate || !pathExists(candidate) || isWindowsSystemBash(candidate, env)) continue;
    return candidate;
  }

  throw new Error(
    "No compatible Bash executable found for subagents. Install Git for Windows, " +
      "make an MSYS2/Cygwin bash.exe available on PATH, or set PI_SUBAGENT_BASH.",
  );
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function withExitSentinel(command: string): string {
  return `${command}; __pi_exit_status=$?; echo '__SUBAGENT_DONE_'"$__pi_exit_status"'__'; exit "$__pi_exit_status"`;
}

type BackgroundSurface = {
  herdr?: HerdrSurface;
  child?: ChildProcess;
  outputFile?: string;
  outputStream?: WriteStream;
  exitCode?: number;
  spawnError?: string;
  mailbox?: string;
  initialMessageIds?: string[];
  pendingInitialMessages?: InteractiveMessage[];
};

const BACKGROUND_PREFIX = "process:";
const backgroundSurfaces = new Map<string, BackgroundSurface>();

export function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith(BACKGROUND_PREFIX);
}

/** Return the process that owns the background surface, when it has spawned. */
export function getSurfaceProcessId(surface: string): number | undefined {
  const state = backgroundSurfaces.get(surface);
  return state?.herdr ? herdrMetadata(state.herdr, true).pid : state?.child?.pid;
}

export function getSurfaceTerminalAddress(surface: string): string | undefined {
  return backgroundSurfaces.get(surface)?.herdr?.address;
}

export function createBackgroundSurface(): string {
  const surface = `${BACKGROUND_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  backgroundSurfaces.set(surface, {});
  return surface;
}

export function createSurface(name: string, config?: Pick<RuntimeConfig, "surfaceBackend">): string {
  const backend = process.env.PI_SUBAGENT_SURFACE_BACKEND ?? (config ?? loadRuntimeConfig()).surfaceBackend;
  if (backend !== "process" && backend !== "herdr") throw new Error(`Unknown subagent surface backend: ${backend}`);
  const herdr = backend === "herdr" ? createHerdrSurface(name) : undefined;
  const surface = createBackgroundSurface();
  if (herdr) backgroundSurfaces.get(surface)!.herdr = herdr;
  return surface;
}

async function waitForInteractiveFile(
  surface: string,
  file: string,
  options: { timeoutMs?: number; sessionFile?: string },
  timeoutMessage: string,
): Promise<any> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    if (options.sessionFile) {
      try {
        const exit = JSON.parse(readFileSync(`${options.sessionFile}.exit`, "utf8"));
        if (exit.type === "error") throw new Error(exit.errorMessage || "Subagent startup failed");
      } catch (error: any) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    const state = backgroundSurfaces.get(surface);
    if (state?.spawnError) throw new Error(state.spawnError);
    const herdrClosed = state?.herdr && herdrMetadata(state.herdr).state === "finished";
    if (!state?.mailbox) throw new Error("Interactive surface closed");
    try { return JSON.parse(readFileSync(join(state.mailbox, file), "utf8")); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (herdrClosed) throw new Error("Interactive Herdr surface closed before confirmation");
    if (state.exitCode !== undefined || state.child?.exitCode != null || state.child?.signalCode != null) {
      throw new Error("Interactive surface closed before confirmation");
    }
    if (!existsSync(state.mailbox)) throw new Error("Interactive IPC disappeared before confirmation");
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function waitSurfaceReady(
  surface: string,
  options: { timeoutMs?: number; sessionFile?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const state = backgroundSurfaces.get(surface);
  const herdr = state?.herdr;
  const remaining = () => ({ ...options, timeoutMs: Math.max(0, deadline - Date.now()) });
  const ready = await waitForInteractiveFile(surface, "ready", remaining(), "Interactive ready handshake timed out");
  if (ready.mode !== "tui") throw new Error("Invalid interactive ready handshake");
  if (herdr) {
    await waitHerdrAdoption(herdr, deadline);
    if (Date.now() >= deadline) throw new Error("Herdr readiness deadline exceeded before bootstrap delivery");
    const pending = state.pendingInitialMessages ?? [];
    state.pendingInitialMessages = undefined;
    state.initialMessageIds ??= [];
    // Fast auto-exit children must not start work before their native pane exists.
    for (const message of pending) state.initialMessageIds.push(publishMessage(state.mailbox!, message));
  }
  for (const id of state?.initialMessageIds ?? []) {
    const ack = await waitForInteractiveFile(surface, `${id}.ack`, herdr ? remaining() : options, `Bootstrap delivery ${id} uncertain: ACK deadline exceeded; no automatic retry`);
    if (ack.id !== id || ack.status !== "accepted") throw new Error(`Bootstrap message rejected: ${ack.error || "invalid ACK"}`);
  }
}

/** Resolve only when Pi accepts the message; generic surfaces retain JSONL input. */
export async function sendCommand(surface: string, command: string, options: { timeoutMs?: number } = {}): Promise<void> {
  const state = backgroundSurfaces.get(surface);
  if (state?.mailbox) {
    if (state.exitCode !== undefined || state.spawnError || (state.herdr && herdrMetadata(state.herdr).state === "finished")) throw new Error("Interactive subagent has closed");
    const id = publishMessage(state.mailbox, { message: command, deliverAs: "steer" });
    const ack = await waitForInteractiveFile(surface, `${id}.ack`, options, `Delivery ${id} uncertain: ACK deadline exceeded; no automatic retry`);
    if (ack.id !== id) throw new Error(`Invalid ACK identity for ${id}`);
    if (ack.status !== "accepted") throw new Error(`Message ${id} rejected: ${ack.error || "invalid ACK"}`);
    return;
  }
  const stdin = state?.child?.stdin;
  if (!state || !stdin || stdin.destroyed || !stdin.writable) {
    throw new Error("Background subagent input is not writable");
  }
  stdin.write(JSON.stringify({
    type: "prompt",
    message: command,
    streamingBehavior: "steer",
  }) + "\n");
}

/**
 * Write a launch script to disk and run it in a background child process.
 * A stable script path preserves the exact invocation for diagnostics.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; initialInput?: string; interactive?: { messages: InteractiveMessage[] } },
): string {
  const state = backgroundSurfaces.get(surface);
  if (!state) throw new Error(`Unknown background surface: ${surface}`);
  if (options?.interactive && !state.herdr && process.platform !== "linux") {
    throw new Error("Interactive Pi subagents require Linux util-linux script (PTY); no RPC fallback is available");
  }
  if (options?.interactive && options.initialInput) throw new Error("Interactive Pi input must use IPC, not stdin");
  if (state.herdr && options?.initialInput) throw new Error("Herdr input must use interactive IPC, not stdin");

  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    // Preambles are diagnostics only. Force every logical line to remain a
    // comment so an untrusted display label can never inject shell commands.
    const comments = options.scriptPreamble
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .map((line) => `# ${line.replace(/^#\s?/, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")}`)
      .join("\n")
      .trimEnd();
    if (comments) scriptParts.push(comments);
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });

  const bash = resolveBackgroundBash();
  const outputFile = `${scriptPath}.log`;
  const shellScriptPath = process.platform === "win32" ? scriptPath.replace(/\\/g, "/") : scriptPath;
  if (options?.interactive) {
    state.mailbox = createMailbox(dirname(scriptPath));
    try {
      if (state.herdr) state.pendingInitialMessages = structuredClone(options.interactive.messages);
      else state.initialMessageIds = options.interactive.messages.map(message => publishMessage(state.mailbox!, message));
    } catch (error) { closeMailbox(state.mailbox); throw error; }
  }
  if (state.herdr) {
    try { launchHerdrSurface(state.herdr, bash, shellScriptPath, state.mailbox); }
    catch (error) {
      if (state.mailbox) closeMailbox(state.mailbox);
      state.spawnError = error instanceof Error ? error.message : "Herdr launch failed";
      throw error;
    }
    return scriptPath;
  }
  const outputStream = createWriteStream(outputFile, { flags: "a" });
  const child = spawn(options?.interactive ? "script" : bash, options?.interactive
    ? ["-q", "-e", "-f", "-c", `${shellEscape(bash)} ${shellEscape(shellScriptPath)}`, "/dev/null"]
    : [shellScriptPath], {
    env: state.mailbox ? { ...process.env, PI_SUBAGENT_IPC_DIR: state.mailbox } : process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  state.child = child;
  state.outputFile = outputFile;
  state.outputStream = outputStream;
  child.stdout?.pipe(outputStream, { end: false });
  child.stderr?.pipe(outputStream, { end: false });
  child.stdin?.on("error", () => {});
  outputStream.on("error", (error) => {
    state.spawnError = `Failed to capture background output: ${error.message}`;
    state.exitCode = 1;
    child.kill("SIGTERM");
  });
  child.once("error", (error) => {
    state.spawnError = options?.interactive ? `Failed to launch Linux PTY via util-linux script: ${error.message}` : error.message;
    if (state.mailbox) closeMailbox(state.mailbox);
  });
  child.once("close", (code) => {
    if (state.mailbox) closeMailbox(state.mailbox);
    outputStream.end(() => {
      state.exitCode = code ?? (state.spawnError ? 1 : 0);
    });
  });

  if (options?.initialInput) {
    const input = options.initialInput.endsWith("\n")
      ? options.initialInput
      : `${options.initialInput}\n`;
    child.stdin?.write(input);
  }
  return scriptPath;
}

function readBackgroundOutput(surface: string, lines: number): string {
  const outputFile = backgroundSurfaces.get(surface)?.outputFile;
  if (!outputFile || !existsSync(outputFile)) return "";

  const fd = openSync(outputFile, "r");
  try {
    const size = fstatSync(fd).size;
    const maxBytes = 256 * 1024;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8").split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
  } finally {
    closeSync(fd);
  }
}

export function readScreen(surface: string, lines = 50): string {
  const herdr = backgroundSurfaces.get(surface)?.herdr;
  return herdr ? readHerdrScreen(herdr) : readBackgroundOutput(surface, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return readScreen(surface, lines);
}

export function descendantProcessIds(rootPid: number, processTable: string): number[] {
  const rows = processTable.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => Number.isInteger(pid) && pid > 0 && Number.isInteger(parent));
  const owned = new Set([rootPid]);
  const descendants: number[] = [];
  for (let index = 0, frontier = [rootPid]; index < frontier.length; index++) {
    for (const [pid, parent] of rows) {
      if (parent === frontier[index] && !owned.has(pid)) {
        owned.add(pid);
        descendants.push(pid);
        frontier.push(pid);
      }
    }
  }
  return descendants.reverse();
}

export function closeSurface(surface: string): void {
  const state = backgroundSurfaces.get(surface);
  const child = state?.child;
  if (state?.mailbox) closeMailbox(state.mailbox);
  if (state?.herdr) {
    closeHerdrSurface(state.herdr);
    backgroundSurfaces.delete(surface);
    return;
  }
  if (child?.pid && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        // Nested surfaces start their own process groups; killing only the root group leaves them alive.
        const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
        for (const pid of descendantProcessIds(child.pid, table)) {
          try { process.kill(pid, "SIGTERM"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
          try { process.kill(pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
          // Let the still-living parent reap each leaf before terminating it.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        try { process.kill(-child.pid, "SIGKILL"); } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
          child.kill("SIGTERM");
        }
      }
    } catch (error) {
      try { process.kill(child.pid, 0); } catch (probe: any) {
        if (probe.code !== "ESRCH") throw error;
        child.stdin?.destroy();
        state?.outputStream?.destroy();
        backgroundSurfaces.delete(surface);
        return;
      }
      throw error;
    }
  }
  child?.stdin?.destroy();
  state?.outputStream?.destroy();
  backgroundSurfaces.delete(surface);
}

export interface PollResult {
  /** How the subagent exited. */
  reason: "done" | "sentinel" | "error";
  /** Child process exit code. */
  exitCode: number;
  /** Provider, launch, or agent error message when available. */
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    const background = backgroundSurfaces.get(surface);
    if (background?.exitCode !== undefined) {
      return background.spawnError
        ? { reason: "error", exitCode: background.exitCode, errorMessage: background.spawnError }
        : { reason: "sentinel", exitCode: background.exitCode };
    }

    if (background?.herdr) {
      try {
        const metadata = herdrMetadata(background.herdr);
        if (metadata.state === "finished") return { reason: "done", exitCode: metadata.exitCode ?? 1 };
      } catch (error) {
        return { reason: "error", exitCode: 1, errorMessage: error instanceof Error ? error.message : "Herdr status failed" };
      }
    }

    try {
      const screen = background?.herdr || background?.mailbox ? "" : await readScreenAsync(surface, 5);
      const match = background?.mailbox ? null : screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
