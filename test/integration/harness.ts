/**
 * Integration test harness for pi-interactive-subagents under Herdr.
 *
 * Guarantees:
 * - Skips cleanly when the Herdr runtime is unavailable (`getAvailableBackends()`).
 * - Every environment owns a scratch TAB created with `--no-focus`, so the
 *   user's view and focus never move during a run.
 * - Panes are tracked and closed on cleanup; an already-gone pane or tab is
 *   tolerated.
 * - Waits use Herdr's own oracles (`pane wait-output`) instead of fixed sleeps.
 * - All paths are platform-aware (`tmpdir()` + `path.join`).
 */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  HerdrError,
  HERDR_SETUP_HINT,
  checkHerdrAvailability,
  closeHerdrPane,
  createHerdrPane,
  listHerdrPanes,
  parseHerdrJson,
  promptHerdrAgent,
  readHerdrPane,
  runHerdr,
  waitHerdrOutput,
  type HerdrPaneInfo,
} from "../../pi-extension/subagents/herdr.ts";
import {
  SUBAGENT_DONE_WAIT_REGEX,
  parseSentinelExitCode,
  quoteArg,
  renderLaunchLine,
  resolveShellSpec,
  writeLaunchScript,
} from "../../pi-extension/subagents/shell.ts";

// ── Paths and configuration ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree. Integration
 * tests must exercise the current branch — never an installed pi-package
 * snapshot — so `startPiInPane` force-loads this file via `pi -ne -e <path>`.
 */
const EXTENSION_SOURCE = join(
  PROJECT_ROOT,
  "pi-extension",
  "subagents",
  "index.ts",
);

/** Model used by lifecycle tests. Override with PI_TEST_MODEL. */
export const TEST_MODEL =
  process.env.PI_TEST_MODEL ?? "deepseek/deepseek-flash";

/** Per-wait timeout in ms. Override with PI_TEST_TIMEOUT. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

/** Returns ["herdr"] when running inside a Herdr pane, else []. */
export function getAvailableBackends(): string[] {
  return process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID
    ? ["herdr"]
    : [];
}

/** Skip reason for suites that need the runtime. */
export const SKIP_REASON =
  "Herdr runtime not available — run pi inside a Herdr pane";

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root. */
  dir: string;
  /** Scratch tab hosting every pane this environment creates. */
  tabId: string;
  /** The scratch tab's root pane — the split target for tracked panes. */
  tabPaneId: string;
  /** Panes created during the test (closed on cleanup, newest first). */
  panes: string[];
  /** Extra files to remove on cleanup. */
  tempFiles: string[];
}

/**
 * Create an isolated environment: temp project dir with the bundled test
 * agents, plus a scratch tab created without focus.
 */
export async function createTestEnv(
  label = `pi-integ-${uniqueId()}`,
): Promise<TestEnv> {
  const availability = await checkHerdrAvailability();
  if (!availability.ok) {
    throw new Error(
      `Herdr unavailable: ${availability.detail ?? availability.hint ?? HERDR_SETUP_HINT}`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  const run = await runHerdr([
    "tab",
    "create",
    "--no-focus",
    "--label",
    label,
    "--cwd",
    dir,
  ]);
  const payload = parseHerdrJson<{
    result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
  }>(run.stdout, "tab create");
  const tabId = payload.result?.tab?.tab_id;
  const tabPaneId = payload.result?.root_pane?.pane_id;
  if (!tabId || !tabPaneId) {
    throw new Error(
      `herdr tab create returned no tab/root pane id: ${run.stdout.slice(0, 200)}`,
    );
  }

  return { dir, tabId, tabPaneId, panes: [], tempFiles: [] };
}

/** Close every pane and the scratch tab, then remove the temp dir. */
export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  for (const paneId of [...env.panes].reverse()) {
    try {
      await closeHerdrPane(paneId);
    } catch {
      /* best effort: panes may already be closed by the test */
    }
  }
  try {
    await runHerdr(["tab", "close", env.tabId]);
  } catch (error) {
    if (
      !(
        error instanceof HerdrError &&
        (error.code === "tab_not_found" || error.code === "pane_not_found")
      )
    ) {
      throw error;
    }
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {
      /* already removed */
    }
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Create a pane inside the scratch tab and track it for cleanup. */
export async function createTrackedPane(
  env: TestEnv,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    targetPane?: string;
    direction?: "right" | "down";
  } = {},
): Promise<string> {
  const paneId = await createHerdrPane({
    targetPane: options.targetPane ?? env.tabPaneId,
    cwd: options.cwd ?? env.dir,
    env: options.env,
    direction: options.direction,
  });
  env.panes.push(paneId);
  return paneId;
}

/** Stop tracking a pane (after it was closed deliberately). */
export function untrackPane(env: TestEnv, paneId: string): void {
  env.panes = env.panes.filter((pane) => pane !== paneId);
}

/** Panes belonging to the environment's scratch tab. */
export async function getEnvPanes(env: TestEnv): Promise<HerdrPaneInfo[]> {
  const panes = await listHerdrPanes();
  return panes.filter((pane) => pane.tab_id === env.tabId);
}

// ── Focus oracle ──

/** The UI-focused pane id, from `pane list`'s focused flag. */
export async function getFocusedPane(): Promise<string | null> {
  const panes = await listHerdrPanes();
  return panes.find((pane) => pane.focused)?.pane_id ?? null;
}

/** Throw when focus moved away from the expected pane. */
export async function assertFocusUnchanged(
  expected: string | null,
  context: string,
): Promise<void> {
  const actual = await getFocusedPane();
  if (actual !== expected) {
    throw new Error(
      `${context}: focus moved from ${expected ?? "none"} to ${actual ?? "none"}`,
    );
  }
}

// ── Command submission and waits ──

/**
 * Write one command as a family-native script and submit the launch line.
 * The line's sentinel appears in pane output when the command finishes, so
 * callers can wait on `SUBAGENT_DONE_WAIT_REGEX` (or a unique marker).
 */
export async function runInPane(
  env: TestEnv,
  paneId: string,
  command: string,
): Promise<string> {
  const spec = resolveShellSpec();
  const scriptPath = writeLaunchScript(
    spec,
    join(env.dir, "scripts"),
    command,
    { baseName: `integ-${uniqueId()}` },
  );
  await runHerdr(["pane", "run", paneId, renderLaunchLine(spec, scriptPath)]);
  return scriptPath;
}

/**
 * Wait until a literal/regex match appears in the pane's recent unwrapped
 * output, then return the captured text. Throws with the tail of the pane
 * output on timeout.
 */
export async function waitForPaneOutput(
  paneId: string,
  pattern: string,
  timeout: number = PI_TIMEOUT,
): Promise<string> {
  try {
    await waitHerdrOutput(paneId, pattern, { lines: 300, timeoutMs: timeout });
  } catch {
    const screen = await readHerdrPane(paneId, 300).catch(() => "");
    throw new Error(
      `Timeout (${timeout}ms) waiting for ${pattern} in pane ${paneId}.\nLast output:\n${screen.slice(-1200)}`,
    );
  }
  return readHerdrPane(paneId, 300);
}

/** Wait for a command's completion sentinel and return its exit code. */
export async function waitForSentinel(
  paneId: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  await waitHerdrOutput(paneId, SUBAGENT_DONE_WAIT_REGEX, {
    lines: 300,
    timeoutMs: timeout,
  });
  const text = await readHerdrPane(paneId, 400);
  return parseSentinelExitCode(text) ?? -1;
}

/**
 * Decode a file written by any supported shell. PowerShell's `>` redirect
 * emits UTF-16LE with a BOM while POSIX shells emit UTF-8 — honoring the BOM
 * keeps content assertions identical on every platform.
 */
export function decodeShellOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return buffer.subarray(2).swap16().toString("utf16le");
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

/** Poll until a file exists and optionally matches a content pattern. */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = decodeShellOutput(readFileSync(path));
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(500);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

// ── Pi session management (lifecycle tests) ──

/**
 * Start a pi session in a pane with the working-tree extension force-loaded.
 * Returns immediately — the pi process runs asynchronously in the pane, and
 * the launch line's sentinel marks its exit.
 */
export async function startPiInPane(
  env: TestEnv,
  paneId: string,
  task: string,
  opts?: { model?: string; extraArgs?: string; sessionFile?: string },
): Promise<void> {
  const spec = resolveShellSpec();
  const model = opts?.model ?? TEST_MODEL;
  const parts = [
    "pi",
    "-ne",
    "-e",
    quoteArg(spec.kind, EXTENSION_SOURCE),
    "--model",
    quoteArg(spec.kind, model),
  ];
  if (opts?.sessionFile) {
    // An explicit session file gives callers a durable transcript oracle.
    parts.push("--session", quoteArg(spec.kind, opts.sessionFile));
  }
  if (opts?.extraArgs) parts.push(opts.extraArgs);
  if (task) parts.push(quoteArg(spec.kind, task));

  const scriptPath = writeLaunchScript(
    spec,
    join(env.dir, "scripts"),
    parts.join(" "),
    { baseName: `pi-${uniqueId()}` },
  );
  await runHerdr(["pane", "run", paneId, renderLaunchLine(spec, scriptPath)]);
}

/** Wait for the pi session in a pane to exit; returns its exit code. */
export async function waitForPiExit(
  paneId: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  return waitForSentinel(paneId, timeout);
}

/** Deliver a prompt to the pi session in a pane through Herdr's agent layer. */
export async function sendPiPrompt(
  paneId: string,
  text: string,
): Promise<void> {
  await promptHerdrAgent(paneId, text);
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Write a helper script into the environment and return its path. */
export function writeEnvScript(
  env: TestEnv,
  name: string,
  source: string,
): string {
  const scriptPath = join(env.dir, "scripts", name);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

/** Register a temp file for cleanup. */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
