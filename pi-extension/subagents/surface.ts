/**
 * Process-backed subagent surface with RPC input and file-backed output.
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
  child?: ChildProcess;
  outputFile?: string;
  outputStream?: WriteStream;
  exitCode?: number;
  spawnError?: string;
};

const BACKGROUND_PREFIX = "process:";
const backgroundSurfaces = new Map<string, BackgroundSurface>();

export function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith(BACKGROUND_PREFIX);
}

/** Return the process that owns the background surface, when it has spawned. */
export function getSurfaceProcessId(surface: string): number | undefined {
  return backgroundSurfaces.get(surface)?.child?.pid;
}

export function createBackgroundSurface(): string {
  const surface = `${BACKGROUND_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  backgroundSurfaces.set(surface, {});
  return surface;
}

export function createSurface(name: string): string {
  void name;
  return createBackgroundSurface();
}

/** Send a prompt to the child process through Pi's JSONL RPC input. */
export function sendCommand(surface: string, command: string): void {
  const state = backgroundSurfaces.get(surface);
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
  options?: { scriptPath?: string; scriptPreamble?: string; initialInput?: string },
): string {
  const state = backgroundSurfaces.get(surface);
  if (!state) throw new Error(`Unknown background surface: ${surface}`);

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
  const outputStream = createWriteStream(outputFile, { flags: "a" });
  const shellScriptPath = process.platform === "win32" ? scriptPath.replace(/\\/g, "/") : scriptPath;
  const child = spawn(bash, [shellScriptPath], {
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
    state.spawnError = error.message;
  });
  child.once("close", (code) => {
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
  return readBackgroundOutput(surface, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return readBackgroundOutput(surface, lines);
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
  if (child?.pid && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        // Nested surfaces start their own process groups; killing only the root group leaves them alive.
        const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
        for (const pid of descendantProcessIds(child.pid, table)) {
          try { process.kill(-pid, "SIGTERM"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
          try { process.kill(pid, "SIGTERM"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
        try { process.kill(-child.pid, "SIGTERM"); } catch (error: any) {
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

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
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
