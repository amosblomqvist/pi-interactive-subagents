/**
 * RPC surface layer — headless subagent children via `pi --mode rpc`.
 *
 * Mirrors the five tmux.ts surface primitives so index.ts can treat both
 * backends identically (see surface.ts for dispatch). Where a tmux surface
 * types a shell command into a pane and screen-scrapes for a sentinel, an
 * RPC surface spawns the child directly (no shell, no multiplexer) and talks
 * JSONL over its stdio.
 *
 * Exit detection is unchanged in kind: the child-side extension
 * (subagent-done.ts) writes a `.exit` sidecar on error stops and calls
 * ctx.shutdown() on completion. We additionally watch the child's process
 * exit — the RPC equivalent of the tmux screen sentinel, minus the shell
 * wrapper that used to produce it.
 *
 * One pi-version caveat drives the "reap nudge": on pi < 0.80.4 an auto-exit
 * child's ctx.shutdown() flag is only consumed after the next handled
 * command, so after a final-looking agent_end with no `agent_settled` event
 * we send a cheap informational command (get_last_assistant_text) ~2s later.
 * On pi ≥ 0.80.4 the child emits `agent_settled` and exits on its own; the
 * nudge is then skipped entirely.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { createRequire } from "node:module";
import { RpcClient, type RpcTransport } from "./rpc-client.ts";
import type { ChildLaunchSpec } from "./surface.ts";
import type { PollResult } from "./tmux.ts";
import { __pollForExitTest__ } from "./tmux.ts";

const interpretExitSidecar = __pollForExitTest__.interpretExitSidecar;

// ── Per-surface state ────────────────────────────────────────────────────────

const DEFAULT_TRANSCRIPT_LINES = 400;
/** How long to wait after a final-looking agent_end before nudging old pi. */
const DEFAULT_NUDGE_DELAY_MS = 2000;

interface RpcSurface {
  id: string;
  transport: RpcTransport;
  transcript: string[];
  maxTranscriptLines: number;
  /** Prompts not yet sent (delivered one run at a time, in order). */
  promptQueue: string[];
  /** A prompt command was sent and its run has not ended yet. */
  promptInFlight: boolean;
  /** Id of the in-flight prompt command (correlates pi's response to it). */
  promptInFlightId: string | null;
  /** Monotonic per-surface counter for prompt command ids. */
  nextPromptId: number;
  /** An agent run is currently active. */
  runActive: boolean;
  /** The child has emitted agent_settled at least once (pi ≥ 0.80.4). */
  sawSettledEvent: boolean;
  autoExit: boolean;
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  nudgeDelayMs: number;
  onChange?: () => void;
  lastError: string | null;
  exited: boolean;
  exitCode: number | null;
}

const rpcSurfaces = new Map<string, RpcSurface>();

export function allocateRpcSurfaceId(): string {
  const rand = () => Math.random().toString(16).slice(2, 10);
  return `rpc:${rand()}-${rand()}`;
}

// ── pi binary resolution ─────────────────────────────────────────────────────

function hasCommand(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve how to start a pi CLI process, in order:
 *   1. PI_SUBAGENT_BIN — explicit override; split on spaces so both
 *      "/usr/local/bin/pi" and "node /path/to/dist/pi.js" work.
 *   2. `pi` on PATH.
 *   3. The host pi package this extension is running inside, resolved from
 *      our own import graph, run with the current node executable. Covers
 *      installs (npx, pi install) where the CLI is not on PATH.
 */
export function resolvePiCommand(): { command: string; args: string[] } {
  const explicit = process.env.PI_SUBAGENT_BIN?.trim();
  if (explicit) {
    const parts = explicit.split(/\s+/).filter(Boolean);
    if (parts.length > 0) return { command: parts[0], args: parts.slice(1) };
  }

  if (hasCommand("pi")) return { command: "pi", args: [] };

  const req = createRequire(import.meta.url);
  for (const pkg of [
    "@mariozechner/pi-coding-agent",
    "@earendil-works/pi-coding-agent",
    "@mariozechner/pi",
  ]) {
    try {
      const pkgJsonPath = req.resolve(`${pkg}/package.json`);
      const pkgDir = req("node:path").dirname(pkgJsonPath);
      const fs = req("node:fs");
      const candidates = [
        req("node:path").join(pkgDir, "dist", "pi.js"),
        req("node:path").join(pkgDir, "bin", "pi.js"),
        req("node:path").join(pkgDir, "dist", "cli.js"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return { command: process.execPath, args: [candidate] };
        }
      }
    } catch {
      // Package not installed under this name — try the next.
    }
  }

  // Last resort: hope PATH works out at spawn time even though command -v
  // didn't find it (different shell environments).
  return { command: "pi", args: [] };
}

/** Build the RPC child argv from a launch spec (no prompts — those go via the queue). */
export function buildRpcArgv(spec: ChildLaunchSpec): string[] {
  const argv: string[] = ["--mode", "rpc"];
  argv.push("--session", spec.sessionFile);
  argv.push("-e", spec.subagentDonePath);

  const loadout = spec.loadout;
  if (loadout.model) {
    argv.push("--model", loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model);
  }
  if (loadout.identity) {
    argv.push(
      loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      systemPromptPathFor(spec),
    );
  }
  if (loadout.toolAllowlist) {
    argv.push("--no-extensions", "--tools", loadout.toolAllowlist);
    // NOTE: tool-backing -e paths are appended by createRpcSurface via
    // resolveToolExtensionPaths — see below.
  }
  return argv;
}

function systemPromptPathFor(spec: ChildLaunchSpec): string {
  // The tmux renderer writes the identity file inside applySandboxToParts;
  // the rpc renderer must produce the same file (same naming scheme) so the
  // child sees the identical sandbox either way.
  const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const spSafeName = spec.name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const spPath = pathJoin(
    spec.artifactDir,
    "context",
    `${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`,
  );
  mkdirSync(pathDirname(spPath), { recursive: true });
  writeFileSync(spPath, spec.loadout.identity!, "utf8");
  return spPath;
}

// ── Prompt materialization ───────────────────────────────────────────────────

/**
 * Expand an "@path" reference exactly as pi's CLI does for positional
 * prompts (cli/file-processor.ts): `<file name="<abs>">\n…\n</file>\n`. The
 * wrapper carries the absolute path, so an rpc child sees the same task
 * bytes — provenance included — as a pane child whose CLI expanded the @file.
 * Unreadable files fall back to the raw reference.
 */
export function expandFileRefForRpc(ref: string): string {
  if (!ref.startsWith("@")) return ref;
  try {
    const absolutePath = pathResolve(ref.slice(1));
    const content = readFileSync(absolutePath, "utf8");
    return `<file name="${absolutePath}">\n${content}\n</file>\n`;
  } catch {
    return ref;
  }
}

/**
 * Turn the raw positional CLI prompts into the effective RPC prompt
 * sequence. The tmux path relies on pi CLI arg parsing to decide which
 * positional becomes the initial message; RPC has no CLI parsing, so:
 *   - "" separator args (a CLI quoting artifact) are dropped
 *   - "@path" file references are inlined (RPC prompts do not expand @files)
 *   - order follows the CLI's effective semantics: artifact delivery runs the
 *     task first with skill prompts as follow-ups (they are argv-only
 *     positionals), direct delivery runs skills first then the task.
 */
export function buildRpcPrompts(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  if (params.taskDelivery === "direct") {
    // No @file artifacts in direct mode — taskArg is the raw task text.
    return [...skillPrompts, params.taskArg];
  }

  const taskArg = params.taskArg;
  const taskPrompt = taskArg.startsWith("@") ? expandFileRefForRpc(taskArg) : taskArg;
  return [taskPrompt, ...skillPrompts];
}

// ── Surface lifecycle ───────────────────────────────────────────────────────

export interface RpcSurfaceOptions {
  /** Child auto-exits after its final run (PI_SUBAGENT_AUTO_EXIT=1). */
  autoExit: boolean;
  /** Called on any state change (for re-rendering the panes dashboard). */
  onChange?: () => void;
  maxTranscriptLines?: number;
  nudgeDelayMs?: number;
  /** Test injection: use a pre-built transport instead of spawning pi. */
  transport?: RpcTransport;
}

function appendTranscript(surface: RpcSurface, line: string): void {
  if (!line) return;
  surface.transcript.push(line);
  if (surface.transcript.length > surface.maxTranscriptLines) {
    surface.transcript.splice(0, surface.transcript.length - surface.maxTranscriptLines);
  }
}

function clearNudge(surface: RpcSurface): void {
  if (surface.nudgeTimer) {
    clearTimeout(surface.nudgeTimer);
    surface.nudgeTimer = null;
  }
}

/**
 * pi < 0.80.4 consumes the child's shutdown flag only on the next handled
 * command, so auto-exit children can park forever after their final run.
 * Arm a nudge: if nothing new happens within nudgeDelayMs, send a cheap
 * informational command. Skipped entirely once the child proves it emits
 * agent_settled (≥ 0.80.4), and skipped while prompts remain queued (the
 * next queued prompt is itself a handled command and starts a real run).
 */
function armNudge(surface: RpcSurface): void {
  if (
    !surface.autoExit ||
    surface.sawSettledEvent ||
    surface.exited ||
    surface.promptQueue.length > 0 ||
    surface.runActive
  ) {
    return;
  }
  clearNudge(surface);
  surface.nudgeTimer = setTimeout(() => {
    surface.nudgeTimer = null;
    // promptInFlight covers the gap between sending a steer and the child's
    // agent_start — the child is busy, nudging would be noise.
    if (!surface.exited && !surface.runActive && !surface.promptInFlight) {
      surface.transport.send({ type: "get_last_assistant_text" });
    }
  }, surface.nudgeDelayMs);
}

/** Deliver queued prompts strictly one run at a time. */
function flushQueue(surface: RpcSurface): void {
  if (surface.exited || surface.promptInFlight || surface.runActive) return;
  const next = surface.promptQueue.shift();
  if (next === undefined) {
    armNudge(surface);
    return;
  }
  // Starting a new run makes any armed nudge moot — the child is busy again.
  clearNudge(surface);
  surface.promptInFlight = true;
  // The id is load-bearing: pi echoes it on the response, which is what makes
  // RpcClient.dispatch route the response to onResponse (id-less responses
  // land in the onEvent stream instead). Rejections must reach
  // handleRpcResponse or the queue freezes forever.
  surface.promptInFlightId = `${surface.id}/prompt/${surface.nextPromptId++}`;
  surface.transport.send({ type: "prompt", id: surface.promptInFlightId, message: next });
}

function handleRpcResponse(surface: RpcSurface, response: any): void {
  if (response?.command !== "prompt" || response?.success !== false) return;
  // Stale rejection (the prompt already retired via agent_end, or nothing in
  // flight at all): setting lastError here would poison the exit poll's
  // error message for a run that actually succeeded.
  if (!surface.promptInFlight) return;
  // Correlate against the in-flight prompt when the response carries an id;
  // a stale rejection (for a prompt already retired by agent_end) is ignored.
  if (response.id != null && surface.promptInFlightId != null && response.id !== surface.promptInFlightId) {
    return;
  }
  // Rejected prompt (no model/API key, dead session, child busy, …): drop it,
  // log, and let the next queued prompt through.
  surface.promptInFlight = false;
  surface.promptInFlightId = null;
  const errorText = response.error ?? "prompt rejected";
  surface.lastError = String(errorText);
  appendTranscript(surface, `✗ prompt rejected: ${errorText}`);
  surface.onChange?.();
  flushQueue(surface);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "query", "url", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.split("\n")[0].slice(0, 80);
    }
  }
  const first = Object.values(record)[0];
  return typeof first === "string" ? first.slice(0, 80) : "";
}

function handleRpcEvent(surface: RpcSurface, event: any): void {
  let mutated = false;
  switch (event?.type) {
    case "agent_start":
      surface.runActive = true;
      clearNudge(surface);
      mutated = true;
      break;
    case "agent_end":
      surface.runActive = false;
      surface.promptInFlight = false;
      surface.promptInFlightId = null;
      if (event.willRetry) appendTranscript(surface, "… retrying after a transient error");
      // Either the run for our prompt just finished, or the child finished a
      // run it started on its own (e.g. a resumed session) — both unblock the
      // queue and re-arm the exit nudge.
      armNudge(surface);
      flushQueue(surface);
      mutated = true;
      break;
    case "agent_settled":
      surface.sawSettledEvent = true;
      clearNudge(surface);
      mutated = true;
      break;
    case "message_start": {
      const role = event.message?.role;
      if (role === "user") {
        const text = textFromContent(event.message?.content).split("\n")[0];
        if (text) appendTranscript(surface, `> ${text.slice(0, 120)}`);
        mutated = true;
      }
      break;
    }
    case "message_end": {
      const role = event.message?.role;
      const text = textFromContent(event.message?.content);
      if (role === "assistant" && text) {
        for (const line of text.split("\n").slice(-6)) {
          appendTranscript(surface, line.trim() === "" ? "" : line);
        }
        mutated = true;
      }
      break;
    }
    case "tool_execution_start":
      appendTranscript(surface, `● ${event.toolName}${summarizeToolArgs(event.args) ? ` (${summarizeToolArgs(event.args)})` : ""}`);
      mutated = true;
      break;
    case "tool_execution_end":
      if (event.isError) {
        appendTranscript(surface, `✗ ${event.toolName} failed`);
        mutated = true;
      }
      break;
    case "auto_retry_start":
      appendTranscript(surface, "… provider retry");
      mutated = true;
      break;
    case "compaction_start":
      appendTranscript(surface, "… compacting context");
      mutated = true;
      break;
    case "error":
    case "extension_error": {
      const message = event.error ?? event.message ?? "unknown error";
      surface.lastError = String(message);
      appendTranscript(surface, `✗ ${String(message).split("\n")[0]}`);
      mutated = true;
      break;
    }
    case "__spawn_error": {
      // Synthetic event from RpcClient when the process could not be spawned
      // at all (ENOENT/EACCES on the pi binary) — without this the poll only
      // ever reports "exited with code -2" with no cause.
      const message = event.message ?? "spawn failed";
      surface.lastError = String(message);
      appendTranscript(surface, `✗ ${String(message).split("\n")[0]}`);
      mutated = true;
      break;
    }
    case "__stderr":
      appendTranscript(surface, event.line);
      mutated = true;
      break;
    case "response":
      // Id-less responses (RpcClient.dispatch routes only id-carrying
      // responses to onResponse) still land here — run them through the same
      // rejection handling so a failed prompt can never freeze the queue.
      handleRpcResponse(surface, event);
      break;
  }
  if (mutated) surface.onChange?.();
}

function registerRpcSurface(
  id: string,
  transport: RpcTransport,
  options: RpcSurfaceOptions,
): RpcSurface {
  const surface: RpcSurface = {
    id,
    transport,
    transcript: [],
    maxTranscriptLines: options.maxTranscriptLines ?? DEFAULT_TRANSCRIPT_LINES,
    promptQueue: [],
    promptInFlight: false,
    promptInFlightId: null,
    nextPromptId: 1,
    runActive: false,
    sawSettledEvent: false,
    autoExit: options.autoExit,
    nudgeTimer: null,
    nudgeDelayMs: options.nudgeDelayMs ?? DEFAULT_NUDGE_DELAY_MS,
    onChange: options.onChange,
    lastError: null,
    exited: false,
    exitCode: null,
  };
  rpcSurfaces.set(id, surface);

  transport.onEvent((event) => handleRpcEvent(surface, event));
  transport.onResponse((response) => handleRpcResponse(surface, response));
  transport.onExit((code) => {
    clearNudge(surface);
    surface.exited = true;
    surface.exitCode = code;
    surface.onChange?.();
  });

  return surface;
}

/**
 * Create a headless RPC surface for a child launch spec: spawn the pi
 * process and queue the effective prompts. Returns the surface id.
 */
export function createRpcSurface(spec: ChildLaunchSpec, options: RpcSurfaceOptions): string {
  const id = allocateRpcSurfaceId();
  // The child's env advertises the surface it lives on, same as tmux panes.
  spec.env.PI_SUBAGENT_SURFACE = id;

  let transport: RpcTransport;
  if (options.transport) {
    transport = options.transport;
  } else {
    const piCommand = resolvePiCommand();
    const argv = [...piCommand.args, ...buildRpcArgv(spec), ...toolExtensionFlags(spec)];
    transport = RpcClient.spawn(piCommand.command, argv, {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd ?? undefined,
    });
  }

  const surface = registerRpcSurface(id, transport, options);

  // The raw CLI prompts are for the tmux renderer; RPC uses the effective
  // sequence (precomputed by index.ts so the CLI's initial-message quirk is
  // reproduced exactly).
  const prompts = spec.rpcPrompts ?? [];
  surface.promptQueue.push(...prompts);
  flushQueue(surface);

  return id;
}

/** -e flags for the extensions backing the whitelisted tools (default-deny). */
function toolExtensionFlags(spec: ChildLaunchSpec): string[] {
  const flags: string[] = [];
  if (!spec.loadout.toolAllowlist) return flags;
  for (const tool of spec.loadout.toolAllowlist.split(",")) {
    const extPath = getToolExtensionPathForRpc(tool);
    if (extPath) flags.push("-e", extPath);
  }
  return flags;
}

// The tool→extension map lives in index.ts (it consults runtime-registered
// extensions). rpc.ts cannot import index.ts (index imports this file), so
// index.ts registers the resolver into this module-global at load time —
// same pattern as __pi_interactive_subagents.registerToolExtension.
const TOOL_EXT_RESOLVER_KEY = Symbol.for("pi-subagents/rpc-tool-ext-resolver");
let toolExtensionResolver: ((tool: string) => string | undefined) | null =
  ((globalThis as any)[TOOL_EXT_RESOLVER_KEY] as any) ?? null;

export function registerToolExtensionResolver(
  resolver: (tool: string) => string | undefined,
): void {
  toolExtensionResolver = resolver;
  (globalThis as any)[TOOL_EXT_RESOLVER_KEY] = resolver;
}

function getToolExtensionPathForRpc(tool: string): string | undefined {
  return toolExtensionResolver?.(tool);
}

// ── Surface primitives (mirroring tmux.ts) ──────────────────────────────────

/**
 * Queue a prompt for a running RPC child (the steer primitive). Throws when
 * the surface is gone or the child has exited — the same contract as the tmux
 * backend's send-keys, so steer callers report the failure instead of
 * claiming a delivery that silently dropped the message.
 */
export function sendRpcCommand(surfaceId: string, command: string): void {
  const surface = rpcSurfaces.get(surfaceId);
  if (!surface) {
    throw new Error(`RPC surface "${surfaceId}" no longer exists`);
  }
  if (surface.exited) {
    throw new Error(
      `RPC child for "${surfaceId}" has exited (code ${surface.exitCode ?? "unknown"})`,
    );
  }
  surface.promptQueue.push(command);
  flushQueue(surface);
}

/**
 * Read the surface's transcript — the RPC analogue of capture-pane. Not used
 * for control flow; exit detection stays sidecar/process based.
 */
export function readRpcScreen(surfaceId: string, lines = 50): string {
  const surface = rpcSurfaces.get(surfaceId);
  if (!surface) return "";
  return surface.transcript.slice(-Math.max(1, lines)).join("\n");
}

/** Transcript for the panes dashboard (line array, most recent last). */
export function readRpcTranscript(surfaceId: string, lines = 8): string[] {
  const surface = rpcSurfaces.get(surfaceId);
  if (!surface) return [];
  return surface.transcript.slice(-Math.max(1, lines));
}

export function rpcSurfaceLastErrorMessage(surfaceId: string): string | null {
  return rpcSurfaces.get(surfaceId)?.lastError ?? null;
}

/** Kill the child's process group and forget the surface. */
export function closeRpcSurface(surfaceId: string): void {
  const surface = rpcSurfaces.get(surfaceId);
  if (!surface) return;
  clearNudge(surface);
  rpcSurfaces.delete(surfaceId);
  try {
    surface.transport.close();
  } catch {
    // Already gone.
  }
}

/** Close all RPC surfaces (module reload / session shutdown). */
export function closeAllRpcSurfaces(): void {
  for (const id of [...rpcSurfaces.keys()]) closeRpcSurface(id);
}

// ── Exit polling ─────────────────────────────────────────────────────────────

/**
 * Poll until the RPC child exits. Same priority order and option shape as
 * the tmux implementation, with the screen-sentinel step replaced by the
 * child's process exit:
 *   1. `.exit` sidecar (error stops — carries errorMessage)
 *   2. sentinel file (Claude plugin only; unused for pi children)
 *   3. process exit (clean shutdown → done, crash → error)
 */
export async function pollRpcForExit(
  surfaceId: string,
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

    // Fast path: .exit sidecar written by subagent-done.ts's error path.
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

    const surface = rpcSurfaces.get(surfaceId);
    if (surface?.exited) {
      const exitCode = surface.exitCode ?? 1;
      if (exitCode === 0) return { reason: "done", exitCode: 0 };
      return {
        reason: "error",
        exitCode,
        errorMessage:
          surface.lastError ??
          `RPC subagent process exited with code ${exitCode}`,
      };
    }
    // Unknown surface (closed by someone else): treat as a clean exit so the
    // watcher's result extraction from the session file still runs.
    if (!surface) {
      return { reason: "done", exitCode: 0 };
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

// ── Test hooks ───────────────────────────────────────────────────────────────

export const __rpcTest__ = {
  rpcSurfaces,
  registerRpcSurface,
  flushQueue,
  armNudge,
  handleRpcEvent,
  handleRpcResponse,
  buildRpcPrompts,
  buildRpcArgv,
  resolvePiCommand,
  appendTranscript,
};