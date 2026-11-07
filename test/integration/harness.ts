/**
 * Integration test harness for process-backed subagents.
 *
 * Provides isolated fixtures, process-backed surfaces, and a lightweight
 * ExtensionAPI driver for live child sessions. No terminal multiplexer or TUI
 * is involved: Pi children run through their JSONL RPC stdin/stdout transport.
 */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  chmodSync,
  lstatSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  createSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
} from "../../pi-extension/subagents/surface.ts";

export {
  createSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

// ── Configuration ──

/** Model used only by explicitly enabled live tests. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test live deadline. Keep the default bounded to one minute. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "60000");

// ── Test environment ──

export interface TestEnv {
  /** Root containing every fixture and potentially sensitive copied file. */
  root: string;
  /** Temp directory serving as the child working directory. */
  dir: string;
  /** Isolated PI_CODING_AGENT_DIR used by child sessions. */
  agentDir: string;
  /** Session directory used only by the synthetic parent session. */
  parentSessionDir: string;
  parentSessionFile: string;
  parentSessionId: string;
  /** Child-process surfaces created directly by surface-layer tests. */
  surfaces: string[];
  /** Extra temp files created by a test. */
  tempFiles: string[];
}

/**
 * Create isolated project, config, agent-definition, and parent-session
 * fixtures. Child sessions deliberately do not use parentSessionDir: the
 * product creates their normal cwd-keyed paths below agentDir/sessions.
 */
export function createTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent-home");
  const agentsDir = join(agentDir, "agents");
  const parentSessionDir = join(root, "parent-sessions");
  const parentSessionId = `parent-${Math.random().toString(16).slice(2, 10)}`;
  const parentSessionFile = join(parentSessionDir, `${parentSessionId}.jsonl`);

  // Keep the complete fixture private because opt-in auth/model files may be
  // copied below agentDir later. chmod is best-effort on Windows but effective
  // on POSIX hosts.
  chmodSync(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(parentSessionDir, { recursive: true, mode: 0o700 });

  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  writeFileSync(
    parentSessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: dir,
    })}\n`,
  );

  return {
    root,
    dir,
    agentDir,
    parentSessionDir,
    parentSessionFile,
    parentSessionId,
    surfaces: [],
    tempFiles: [],
  };
}

type CleanupOperations = {
  close?: (surface: string) => void;
  removeRoot?: (root: string) => void;
};

/** Case-insensitive subagent runtime/config key test for synthetic-parent isolation. */
export function isSubagentEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith("PI_SUBAGENT_") || upper === "PI_SUBAGENTS_CONFIG";
}

/** Remove inherited subagent runtime/config variables and retain an exact snapshot. */
export function stripSubagentEnvironment(
  environment: NodeJS.ProcessEnv,
): Array<[string, string]> {
  const snapshot: Array<[string, string]> = [];
  for (const key of Object.keys(environment)) {
    if (!isSubagentEnvironmentKey(key)) continue;
    const value = environment[key];
    if (value !== undefined) snapshot.push([key, value]);
    delete environment[key];
  }
  return snapshot;
}

/** Remove any new runtime/config contamination, then restore the exact snapshot. */
export function restoreSubagentEnvironment(
  environment: NodeJS.ProcessEnv,
  snapshot: Array<[string, string]>,
): void {
  for (const key of Object.keys(environment)) {
    if (isSubagentEnvironmentKey(key)) delete environment[key];
  }
  for (const [key, value] of snapshot) environment[key] = value;
}

const EXPLICIT_CONFIG_FIXTURES = [
  ["PI_TEST_AUTH_FILE", "auth.json"],
  ["PI_TEST_MODELS_FILE", "models.json"],
] as const;

/**
 * Copy only executor-selected concrete files into the private temporary Pi
 * config. Contents are copied opaquely and are never parsed or logged.
 */
export function stageExplicitPiConfigFiles(
  env: TestEnv,
  environment: NodeJS.ProcessEnv = process.env,
  sourceBase: string = process.cwd(),
): string[] {
  const staged: string[] = [];
  for (const [variable, destinationName] of EXPLICIT_CONFIG_FIXTURES) {
    const selected = environment[variable]?.trim();
    if (!selected) continue;
    const source = resolve(sourceBase, selected);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${variable} must select a concrete regular file: ${source}`);
    }
    const destination = join(env.agentDir, destinationName);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
    staged.push(destination);
  }
  return staged;
}

/** Terminate named test-owned surfaces and report every failure. */
export function terminateTestSurfaces(
  surfaces: Iterable<string>,
  close: (surface: string) => void = closeSurface,
): void {
  const errors: Error[] = [];
  for (const surface of new Set(surfaces)) {
    try {
      close(surface);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to terminate test-owned child processes");
  }
}

/**
 * Close test-owned processes before deleting the fixture root. Cleanup failures
 * are propagated because the root may contain copied credentials.
 */
export function cleanupTestEnv(env: TestEnv, operations: CleanupOperations = {}): void {
  terminateTestSurfaces(env.surfaces, operations.close ?? closeSurface);

  const unlinkErrors: Error[] = [];
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        unlinkErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  if (unlinkErrors.length > 0) {
    throw new AggregateError(
      unlinkErrors,
      `Failed to clean test files; private fixture retained at ${env.root}`,
    );
  }

  try {
    (operations.removeRoot ?? ((root) => rmSync(root, { recursive: true, force: true })))(env.root);
  } catch (error) {
    throw new AggregateError(
      [error instanceof Error ? error : new Error(String(error))],
      `Failed to remove private test fixture at ${env.root}`,
    );
  }
}

/** Create a surface and register it for automatic cleanup. */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name, { surfaceBackend: "process" });
  env.surfaces.push(surface);
  return surface;
}

/** Remove a surface from tracking after manual close. */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Synthetic-parent driver for live child integration tests ──

type SentMessage = { message: any; options?: any };

type ExtensionDriver = {
  env: TestEnv;
  ctx: any;
  tool(name: string): any;
  sentMessages: SentMessage[];
  waitForMessage(
    predicate: (entry: SentMessage) => boolean,
    options?: { from?: number; timeout?: number },
  ): Promise<SentMessage>;
  stop(): Promise<void>;
};

/**
 * Load the real extension against a synthetic parent ExtensionAPI while every
 * launched child is a real Pi subprocess using JSONL RPC. This intentionally
 * does not test the parent Pi loader, parent RPC protocol, or TUI/UI rendering.
 */
export async function createExtensionDriver(env: TestEnv): Promise<ExtensionDriver> {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousExplicitConfigEnv = new Map(
    EXPLICIT_CONFIG_FIXTURES.map(([variable]) => [variable, process.env[variable]]),
  );
  process.chdir(env.dir);
  process.env.PI_CODING_AGENT_DIR = env.agentDir;
  // The driver is a synthetic top-level orchestrator even when its test command
  // was launched from a subagent. Match all key casing variants and future
  // PI_SUBAGENT_* additions plus the plural PI_SUBAGENTS_CONFIG override rather
  // than maintaining a partial allowlist. Real extension children still
  // inherit PI_SUBAGENTS_CONFIG normally; only this synthetic root is isolated.
  const previousSubagentEnv = stripSubagentEnvironment(process.env);
  // PI_OFFLINE suppresses Pi startup/update/package traffic only. The explicit
  // live child prompt still calls and consumes the selected model provider.
  process.env.PI_OFFLINE = "1";

  const restoreProcessState = () => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    for (const [variable] of EXPLICIT_CONFIG_FIXTURES) {
      const previous = previousExplicitConfigEnv.get(variable);
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
    restoreSubagentEnvironment(process.env, previousSubagentEnv);
  };

  const registeredTools: any[] = [];
  const eventHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const sentMessages: SentMessage[] = [];
  const messageWaiters = new Set<() => void>();
  const ui = {
    setWidget() {},
    setStatus() {},
    notify() {},
  };
  const ctx = {
    cwd: env.dir,
    mode: "rpc",
    hasUI: false,
    ui,
    sessionManager: {
      getSessionFile: () => env.parentSessionFile,
      getSessionId: () => env.parentSessionId,
      getSessionDir: () => env.parentSessionDir,
    },
  };
  const api = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    sendUserMessage() {},
    sendMessage(message: any, options?: any) {
      sentMessages.push({ message, options });
      for (const notify of [...messageWaiters]) notify();
    },
    getAllTools() {
      return [];
    },
  };

  let module: typeof import("../../pi-extension/subagents/index.ts");
  try {
    stageExplicitPiConfigFiles(env, process.env, previousCwd);
    // Children receive only the private copies through PI_CODING_AGENT_DIR,
    // never the executor-selected source paths.
    for (const [variable] of EXPLICIT_CONFIG_FIXTURES) delete process.env[variable];
    module = await import("../../pi-extension/subagents/index.ts");
    module.default(api as any);
    for (const handler of eventHandlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, ctx);
    }
  } catch (error) {
    restoreProcessState();
    try {
      cleanupTestEnv(env);
    } catch (cleanupError) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error(String(error)),
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        ],
        `Driver setup failed and private fixture cleanup also failed at ${env.root}`,
      );
    }
    throw error;
  }

  const preexistingRunningIds = new Set(module.__test__.runningSubagents.keys());
  let stopped = false;
  return {
    env,
    ctx,
    sentMessages,
    tool(name: string) {
      const found = registeredTools.find((tool) => tool.name === name);
      if (!found) throw new Error(`Extension tool not registered: ${name}`);
      return found;
    },
    waitForMessage(predicate, options = {}) {
      const from = options.from ?? 0;
      const timeout = options.timeout ?? PI_TIMEOUT;
      const existing = sentMessages.slice(from).find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<SentMessage>((resolveMessage, reject) => {
        const timer = setTimeout(() => {
          messageWaiters.delete(check);
          reject(new Error(
            `Timeout (${timeout}ms) waiting for extension message. Seen: ` +
              sentMessages.slice(from).map((entry) => entry.message?.customType ?? "unknown").join(", "),
          ));
        }, timeout);
        const check = () => {
          const match = sentMessages.slice(from).find(predicate);
          if (!match) return;
          clearTimeout(timer);
          messageWaiters.delete(check);
          resolveMessage(match);
        };
        messageWaiters.add(check);
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const running = module.__test__.runningSubagents as Map<string, { surface: string }>;
      // Capture only this driver's children before the extension shutdown hook
      // aborts watchers and clears its global map.
      const ownedChildren = [...running.entries()]
        .filter(([id]) => !preexistingRunningIds.has(id))
        .map(([, child]) => child);
      const shutdownErrors: Error[] = [];

      for (const handler of eventHandlers.get("session_shutdown") ?? []) {
        try {
          await handler({ reason: "quit" }, ctx);
        } catch (error) {
          shutdownErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        terminateTestSurfaces(ownedChildren.map((child) => child.surface));
      } catch (error) {
        shutdownErrors.push(error instanceof Error ? error : new Error(String(error)));
      }

      restoreProcessState();
      if (shutdownErrors.length > 0) {
        throw new AggregateError(
          shutdownErrors,
          `Failed to shut down test-owned children; private fixture retained at ${env.root}`,
        );
      }
      cleanupTestEnv(env);
    },
  };
}

// ── Polling helpers for local process tests ──

export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(250);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast output:\n${finalScreen.slice(-1000)}`,
  );
}

export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(250);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
