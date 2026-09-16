/**
 * Herdr pane adapter — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the API in this file:
 * availability and version gating, no-focus pane creation with cwd/env,
 * shell-family detection, command/text submission, plain unwrapped screen
 * reads, regex output waits, idempotent close, and agent-layer delivery
 * gated on readiness. index.ts consumes this API without knowing Herdr
 * command syntax.
 *
 * Herdr facts this adapter relies on (verified against Herdr 0.9.0 /
 * protocol 22):
 *  - The CLI prints a JSON envelope on stdout: {"id":"cli:<cmd>","result":…}.
 *  - Failures print {"error":{"code":…,"message":…}} on STDERR with exit 1;
 *    CLI usage errors exit 2 without JSON.
 *  - `pane split` accepts --current/--pane, --direction right|down, --cwd,
 *    repeated --env KEY=VALUE, and --no-focus; creation never steals focus.
 *  - `pane run` writes text a shell parses (text + Enter); `agent prompt`
 *    submits a turn through the agent layer once the child is ready.
 *  - `agent get` reports agent_status: idle|working|blocked|done|unknown.
 *  - `pane wait-output --regex … --timeout <ms>` searches the snapshot
 *    immediately (including existing output), then polls server-side; expiry
 *    fails with the `timeout` code.
 */
import { execFile } from "node:child_process";
import type { ShellKind } from "./shell.ts";

// ── Error contract (design D7): a typed result, not thrown strings ──

export type HerdrErrorCode =
  | "pane_not_found"
  | "tab_not_found"
  | "agent_not_found"
  | "agent_pane_busy"
  | "agent_prompt_stalled"
  | "agent_blocked"
  | "timeout"
  | "unknown";

const KNOWN_ERROR_CODES: readonly HerdrErrorCode[] = [
  "pane_not_found",
  "tab_not_found",
  "agent_not_found",
  "agent_pane_busy",
  "agent_prompt_stalled",
  "agent_blocked",
  "timeout",
];

export class HerdrError extends Error {
  readonly code: HerdrErrorCode;
  /** True when the CLI rejected the invocation itself (exit 2) — an internal or version defect. */
  readonly usageError: boolean;
  readonly rawStderr: string;
  readonly exitStatus: number;

  constructor(
    code: HerdrErrorCode,
    message: string,
    options: {
      usageError?: boolean;
      rawStderr?: string;
      exitStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
    this.usageError = options.usageError ?? false;
    this.rawStderr = options.rawStderr ?? "";
    this.exitStatus = options.exitStatus ?? 0;
  }
}

/** pane_not_found / agent_not_found end the run; nothing will make them succeed. */
export function isTerminalHerdrError(err: unknown): boolean {
  return (
    err instanceof HerdrError &&
    (err.code === "pane_not_found" || err.code === "agent_not_found")
  );
}

/** Only the agent-layer busy condition is retryable (design D3). */
export function isRetryableHerdrError(err: unknown): boolean {
  return err instanceof HerdrError && err.code === "agent_pane_busy";
}

// ── Process runner (injectable for tests) ──

export interface HerdrRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HerdrRunner = (
  file: string,
  args: string[],
  options: { timeoutMs?: number },
) => Promise<HerdrRunResult>;

const defaultRunner: HerdrRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs,
      },
      (err, stdout, stderr) => {
        const execErr = err as (Error & { code?: number | string }) | null;
        if (!execErr) {
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        if (typeof execErr.code === "number") {
          resolve({
            code: execErr.code,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
          return;
        }
        // Spawn failure (herdr not on PATH): no process ran at all.
        resolve({
          code: 127,
          stdout: "",
          stderr: execErr.message ?? String(execErr),
        });
      },
    );
  });

let activeRunner: HerdrRunner = defaultRunner;

/** Test hooks, following the repo's __…Test__ export convention. */
export const __herdrTestHooks__ = {
  setRunner(runner: HerdrRunner | null): void {
    activeRunner = runner ?? defaultRunner;
  },
  resetRunner(): void {
    activeRunner = defaultRunner;
  },
};

function tryParseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Non-JSON payload — callers treat this as an unclassified failure.
    return { ok: false };
  }
}

function classifyFailure(run: HerdrRunResult): HerdrError {
  const parsed = tryParseJson(run.stderr);
  if (parsed.ok) {
    const payload = parsed.value as {
      error?: { code?: unknown; message?: unknown };
    };
    const rawCode = payload?.error?.code;
    const rawMessage = payload?.error?.message;
    if (typeof rawCode === "string") {
      const code = KNOWN_ERROR_CODES.includes(rawCode as HerdrErrorCode)
        ? (rawCode as HerdrErrorCode)
        : "unknown";
      const message =
        typeof rawMessage === "string" && rawMessage ? rawMessage : rawCode;
      return new HerdrError(code, `herdr failed (${code}): ${message}`, {
        usageError: run.code === 2,
        rawStderr: run.stderr,
        exitStatus: run.code,
      });
    }
  }
  const detail = run.stderr.trim() || `exit status ${run.code}`;
  return new HerdrError(
    "unknown",
    `herdr failed with unclassified error: ${detail}`,
    {
      usageError: run.code === 2,
      rawStderr: run.stderr,
      exitStatus: run.code,
    },
  );
}

/**
 * Run one herdr CLI command (argv array — never a shell string) and return
 * its stdout. Non-zero exits throw a classified HerdrError.
 */
export async function runHerdr(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<HerdrRunResult> {
  const run = await activeRunner("herdr", args, options);
  if (run.code !== 0) throw classifyFailure(run);
  return run;
}

/** Parse the JSON envelope from a successful run; a non-JSON success is a defect. */
export function parseHerdrJson<T = unknown>(
  stdout: string,
  context: string,
): T {
  const parsed = tryParseJson(stdout);
  if (!parsed.ok) {
    throw new HerdrError(
      "unknown",
      `herdr ${context} printed non-JSON output: ${stdout.slice(0, 200)}`,
    );
  }
  return parsed.value as T;
}

/** Retry a call only while Herdr reports the retryable busy condition (design D3). */
export async function runHerdrWithBusyRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; backoffMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 120;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableHerdrError(err) || attempt >= retries) throw err;
      attempt += 1;
      if (backoffMs > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, backoffMs * attempt),
        );
    }
  }
}

// ── Availability and version gating (design D6) ──

export const HERDR_SETUP_HINT = "Start Herdr, then run pi inside a Herdr pane.";
/** The baseline this change was verified against; raise only when a newly used command requires it. */
export const HERDR_SERVER_FLOOR = { version: "0.9.0", protocol: 22 } as const;

export interface HerdrAvailability {
  ok: boolean;
  /** Actionable hint for the user when ok is false. */
  hint?: string;
  /** Technical detail for logs/diagnostics. */
  detail?: string;
}

export function isHerdrEnvPresent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID?.trim());
}

/** Numeric three-part version compare; missing components count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface HerdrStatusPayload {
  client?: { version?: string; protocol?: number };
  server?: {
    status?: string;
    running?: boolean;
    version?: string;
    protocol?: number;
    compatible?: boolean;
    endpoint_compatible?: boolean;
  };
}

export async function getHerdrStatus(): Promise<HerdrStatusPayload> {
  const run = await runHerdr(["status", "--json"]);
  return parseHerdrJson<HerdrStatusPayload>(run.stdout, "status --json");
}

/**
 * Availability requires HERDR_ENV=1, HERDR_PANE_ID, a reachable server, and
 * a server at or above the version/protocol floor. Never attaches to a
 * session pi was not started in.
 */
export async function checkHerdrAvailability(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrAvailability> {
  if (!isHerdrEnvPresent(env)) {
    return {
      ok: false,
      hint: HERDR_SETUP_HINT,
      detail:
        "HERDR_ENV=1 and HERDR_PANE_ID are not set; pi is not running inside a Herdr pane.",
    };
  }
  let status: HerdrStatusPayload;
  try {
    status = await getHerdrStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      hint: HERDR_SETUP_HINT,
      detail: `Herdr server not reachable: ${message}`,
    };
  }
  const server = status?.server;
  if (!server || server.status !== "running") {
    return {
      ok: false,
      hint: HERDR_SETUP_HINT,
      detail: "Herdr server is not running.",
    };
  }
  if (server.compatible === false || server.endpoint_compatible === false) {
    return {
      ok: false,
      hint: "Upgrade Herdr so the client and server versions match.",
      detail: `Server ${server.version ?? "unknown"} reports endpoint incompatibility.`,
    };
  }
  const protocol =
    typeof server.protocol === "number" ? server.protocol : Number.NaN;
  if (!(protocol >= HERDR_SERVER_FLOOR.protocol)) {
    return {
      ok: false,
      hint: `Upgrade Herdr; server protocol ${HERDR_SERVER_FLOOR.protocol}+ is required (found ${
        Number.isNaN(protocol) ? "unknown" : protocol
      }).`,
      detail: `Server version ${server.version ?? "unknown"}.`,
    };
  }
  if (
    typeof server.version === "string" &&
    compareVersions(server.version, HERDR_SERVER_FLOOR.version) < 0
  ) {
    return {
      ok: false,
      hint: `Upgrade Herdr; server ${HERDR_SERVER_FLOOR.version}+ is required (found ${server.version}).`,
      detail: undefined,
    };
  }
  return { ok: true };
}

// ── Pane creation (design D1/D10: pane layer owns lifecycle, focus never moves) ──

export interface HerdrPaneSplitOptions {
  /** Explicit pane to split; defaults to the caller's pane (--current). */
  targetPane?: string;
  direction?: "right" | "down";
  cwd?: string;
  /** Environment applied to the launched pane process; runtime-managed variables stay authoritative. */
  env?: Record<string, string>;
}

/** Pane ids look like "w1:p1" (workspace:pane). */
const PANE_ID_PATTERN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

function extractPaneId(payload: unknown): string {
  const result =
    (payload as { result?: Record<string, unknown> })?.result ?? {};
  const pane = (result.pane ?? {}) as Record<string, unknown>;
  const candidate =
    pane.pane_id ?? result.pane_id ?? result.paneId ?? result.id;
  if (typeof candidate !== "string" || !PANE_ID_PATTERN.test(candidate)) {
    throw new HerdrError(
      "unknown",
      `herdr pane split returned no valid pane id (got ${JSON.stringify(candidate) ?? "undefined"})`,
    );
  }
  return candidate;
}

/**
 * Create a subagent pane as a split of the calling pane without stealing
 * focus, passing cwd and environment at creation instead of shell syntax.
 * Returns the validated pane id.
 */
export async function createHerdrPane(
  options: HerdrPaneSplitOptions = {},
): Promise<string> {
  const args = ["pane", "split"];
  if (options.targetPane) args.push("--pane", options.targetPane);
  else args.push("--current");
  args.push("--direction", options.direction ?? "right");
  args.push("--no-focus");
  if (options.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  const run = await runHerdr(args);
  return extractPaneId(parseHerdrJson(run.stdout, "pane split"));
}

// ── Shell-family detection (design D5: validated, not assumed) ──

export interface HerdrProcessInfo {
  process_info?: {
    foreground_processes?: Array<{ name?: string; argv?: string[] }>;
    pane_id?: string;
    shell_pid?: number;
  };
}

export async function getPaneProcessInfo(
  paneId: string,
): Promise<HerdrProcessInfo> {
  const run = await runHerdr(["pane", "process-info", "--pane", paneId]);
  const payload = parseHerdrJson<{ result?: HerdrProcessInfo }>(
    run.stdout,
    "pane process-info",
  );
  return payload.result ?? {};
}

const POWERSHELL_NAMES = new Set(["powershell", "pwsh"]);
const POSIX_SHELL_NAMES = new Set(["bash", "zsh", "sh"]);

/**
 * Resolve the pane's shell family from the runtime's foreground process
 * information — never from the operating system. Returns null when no
 * foreground process names a supported shell.
 */
export function shellFamilyFromProcessInfo(
  info: HerdrProcessInfo,
): ShellKind | null {
  const processes = info?.process_info?.foreground_processes ?? [];
  for (const proc of processes) {
    const raw = proc?.name ?? proc?.argv?.[0] ?? "";
    const base =
      raw
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.exe$/i, "")
        .toLowerCase() ?? "";
    if (POWERSHELL_NAMES.has(base)) return "powershell";
    if (POSIX_SHELL_NAMES.has(base)) return "posix";
  }
  return null;
}

/**
 * Verify the pane Herdr actually started runs a shell of the resolved family
 * before any command is rendered. A mismatch is an actionable error, not a
 * mis-quoted command.
 */
export async function assertPaneShellFamily(
  paneId: string,
  expected: ShellKind,
): Promise<void> {
  // A freshly split pane can briefly report no foreground process, so poll
  // for up to a few seconds before treating the family as unrecognized.
  const deadline = Date.now() + 5000;
  let detected: ShellKind | null = null;
  for (;;) {
    const info = await getPaneProcessInfo(paneId);
    detected = shellFamilyFromProcessInfo(info);
    if (detected !== null || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (detected !== expected) {
    throw new HerdrError(
      "unknown",
      `Pane ${paneId} runs a ${detected ?? "unrecognized"} shell but the launch was rendered for ${expected}. ` +
        `Set PI_SUBAGENT_SHELL to match the pane's shell (or change Herdr's default shell) and retry.`,
    );
  }
}

// ── Submission (task 2.5) ──

/** Submit one pre-quoted command line: text the pane's shell parses, plus Enter. */
export async function runHerdrCommand(
  paneId: string,
  command: string,
): Promise<void> {
  await runHerdr(["pane", "run", paneId, command]);
}

/** Send literal text without pressing Enter. */
export async function sendHerdrText(
  paneId: string,
  text: string,
): Promise<void> {
  await runHerdr(["pane", "send-text", paneId, text]);
}

/** Press Enter in a pane (completes a pending send-text submission). */
export async function sendHerdrEnter(paneId: string): Promise<void> {
  await runHerdr(["pane", "send-keys", paneId, "enter"]);
}

/** Escape a literal string for use as a Herdr regex match. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Atomic text + Enter for the degraded delivery path (design D2).
 *
 * Herdr applies no size-aware submit delay on this transport, so an Enter
 * sent immediately after a paste can be swallowed while the paste is still
 * being processed — submitting partially or not at all. Wait until the
 * pasted tail is visible in the pane before pressing Enter. The wait is
 * bounded and best-effort: if the echo cannot be observed, Enter is still
 * sent.
 */
export async function submitHerdrText(
  paneId: string,
  text: string,
): Promise<void> {
  await sendHerdrText(paneId, text);
  const lastLine = text.trimEnd().split("\n").pop()?.trim() ?? "";
  if (lastLine) {
    const probe = lastLine.length > 120 ? lastLine.slice(-120) : lastLine;
    await waitHerdrOutput(paneId, escapeRegexLiteral(probe), {
      lines: 200,
      timeoutMs: 5000,
    }).catch(() => {
      /* best effort: press Enter even when the echo could not be observed */
    });
  }
  await sendHerdrEnter(paneId);
}

// ── Screen reads (task 2.6: plain, unwrapped, no escapes) ──

/** Read the pane's recent output as plain text that ignores soft wrapping. */
export async function readHerdrPane(
  paneId: string,
  lines = 50,
): Promise<string> {
  const run = await runHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
  return run.stdout;
}

// ── Output waits (task 2.7) ──

export interface HerdrWaitOptions {
  lines?: number;
  timeoutMs: number;
}

/**
 * Wait until the regex appears in the pane's recent unwrapped output. The
 * snapshot is searched immediately, then polled server-side. Expiry throws
 * HerdrError with the distinct `timeout` code — never conflated with
 * pane_not_found.
 */
export async function waitHerdrOutput(
  paneId: string,
  regex: string,
  options: HerdrWaitOptions,
): Promise<void> {
  const args = [
    "pane",
    "wait-output",
    "--regex",
    regex,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, options.lines ?? 50)),
    "--timeout",
    String(Math.max(1, options.timeoutMs)),
    paneId,
  ];
  await runHerdr(args, { timeoutMs: options.timeoutMs + 5000 });
}

// ── Close (task 2.8: idempotent cleanup) ──

/**
 * Close a pane. A pane that is already gone counts as success — cleanup must
 * never fail because the target vanished first.
 */
export async function closeHerdrPane(paneId: string): Promise<void> {
  try {
    await runHerdr(["pane", "close", paneId]);
  } catch (err) {
    if (err instanceof HerdrError && err.code === "pane_not_found") return;
    throw err;
  }
}

// ── Agent layer (tasks 2.x + design D2/D3: readiness gate and delivery) ──

export type HerdrAgentState =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

export interface HerdrAgentInfo {
  agent?: { agent_status?: string; pane_id?: string; cwd?: string };
}

export function agentStateFromPayload(
  payload: HerdrAgentInfo | null | undefined,
): HerdrAgentState {
  const status = payload?.agent?.agent_status;
  if (
    status === "idle" ||
    status === "working" ||
    status === "blocked" ||
    status === "done"
  ) {
    return status;
  }
  return "unknown";
}

/** Read the recognized agent state of a pane (busy-retried). */
export async function getHerdrAgent(paneId: string): Promise<HerdrAgentState> {
  const run = await runHerdrWithBusyRetry(() =>
    runHerdr(["agent", "get", paneId]),
  );
  const payload = parseHerdrJson<{ result?: HerdrAgentInfo }>(
    run.stdout,
    "agent get",
  );
  return agentStateFromPayload(payload.result);
}

/**
 * Submit a prompt to the agent running in a pane (busy-retried). Targeting by
 * pane id works for unnamed shell-launched agents. Callers gate on a ready
 * state first; a prompt that fails to start a turn is reported, never
 * assumed delivered.
 */
export async function promptHerdrAgent(
  paneId: string,
  text: string,
): Promise<void> {
  await runHerdrWithBusyRetry(() =>
    runHerdr(["agent", "prompt", paneId, text]),
  );
}

// ── Pane listing (focus oracle for tests, design D12) ──

export interface HerdrPaneInfo {
  pane_id?: string;
  focused?: boolean;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  tab_id?: string;
}

export async function listHerdrPanes(): Promise<HerdrPaneInfo[]> {
  const run = await runHerdr(["pane", "list"]);
  const payload = parseHerdrJson<{ result?: { panes?: HerdrPaneInfo[] } }>(
    run.stdout,
    "pane list",
  );
  return payload?.result?.panes ?? [];
}
