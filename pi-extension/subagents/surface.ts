/**
 * Surface abstraction: subagent children run either in tmux panes (the
 * historical backend) or as headless `pi --mode rpc` processes (the backend
 * that removes the tmux dependency). This module owns the shared launch-spec
 * type, backend selection, and id-prefix dispatch. The implementations stay
 * in tmux.ts and rpc.ts; call sites in index.ts never branch on the backend
 * directly — they go through the dispatchers here.
 *
 * Surface ids are namespaced by prefix:
 *   "%12"      — tmux pane id (tmux guarantees the leading %)
 *   "rpc:<id>" — headless RPC child
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentLoadout } from "./session.ts";
import { isTmuxAvailable } from "./tmux.ts";
import { closeRpcSurface, pollRpcForExit, readRpcScreen, sendRpcCommand } from "./rpc.ts";
import {
  closeSurface as closeTmuxSurface,
  pollForExit as pollTmuxForExit,
  readScreen as readTmuxScreen,
  sendCommand as sendTmuxCommand,
  type PollResult,
} from "./tmux.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

// ── Launch spec ──────────────────────────────────────────────────────────────

/**
 * A raw, structured description of a child pi launch — before it is rendered
 * to any surface. Built once by index.ts, then consumed by one of two
 * renderers:
 *
 *   - tmux (renderTmuxCommand in index.ts): shell string, byte-identical to
 *     the pre-refactor command construction, typed into a pane.
 *   - rpc (rpc.ts): spawn() argv + env + a prompt queue delivered as RPC
 *     `prompt` commands.
 */
export interface ChildLaunchSpec {
  kind: "pi";
  /** Session file passed via --session (created/seeded by the caller). */
  sessionFile: string;
  /** Path to subagent-done.ts — always the first -e flag. */
  subagentDonePath: string;
  /** Sandbox snapshot (model, identity, tool allowlist). */
  loadout: SubagentLoadout;
  /** Artifact dir for this parent session (system-prompt files go here). */
  artifactDir: string;
  /** Display name — used for generated file names. */
  name: string;
  /** Env additions for the child, in emission order (insertion order is kept). */
  env: Record<string, string>;
  /** Working directory, or null to inherit. */
  cwd: string | null;
  /** Positional CLI prompts in argv order ("" separators and "@file" forms raw). */
  prompts: string[];
  /**
   * Effective prompt sequence for the RPC backend, when it differs from
   * `prompts`. The tmux path relies on pi CLI arg parsing to decide which
   * positional becomes the initial message (artifact mode: the @file text
   * becomes the initial message and later positionals become follow-ups);
   * the rpc backend has no CLI arg parsing, so index.ts precomputes the
   * same effective sequence here (see buildRpcPrompts).
   */
  rpcPrompts?: string[];
}

// ── Backend selection ────────────────────────────────────────────────────────

export type SurfaceBackendChoice = "auto" | "tmux" | "rpc";
export type SurfaceBackend = "tmux" | "rpc";

export interface SurfaceConfig {
  backend: SurfaceBackendChoice;
  panesEnabled: boolean;
}

export function parseSurfaceConfig(rawConfig: unknown): Pick<SurfaceConfig, "backend"> {
  const surface = (rawConfig as any)?.surface;
  const backend = surface?.backend;
  if (backend === "tmux" || backend === "rpc" || backend === "auto") {
    return { backend };
  }
  // Unknown/missing keys never throw — old configs keep their "auto" default.
  return { backend: "auto" };
}

export function loadSurfaceConfig(): SurfaceConfig {
  let backend: SurfaceBackendChoice = "auto";
  let panesEnabled = true;
  try {
    // config.json wins over config.json.example — same discovery order as
    // status.ts, so one repo config file drives both features.
    const rawConfig = existsSync(CONFIG_PATH)
      ? readFileSync(CONFIG_PATH, "utf8")
      : existsSync(CONFIG_EXAMPLE_PATH)
        ? readFileSync(CONFIG_EXAMPLE_PATH, "utf8")
        : null;
    if (rawConfig) {
      const parsed = JSON.parse(rawConfig) as any;
      backend = parseSurfaceConfig(parsed).backend;
      const panes = parsed?.surface?.panes;
      if (panes && typeof panes === "object" && typeof panes.enabled === "boolean") {
        panesEnabled = panes.enabled;
      }
    }
  } catch {
    // Malformed config — fall back to defaults rather than break spawning.
  }

  // Env overrides win, for one-off testing without editing config files:
  //   PI_SUBAGENT_SURFACE=rpc|tmux   forces a backend
  //   PI_SUBAGENT_PANES=0|1          forces the dashboard off/on
  // A subagent child's PI_SUBAGENT_SURFACE holds its *surface id* ("rpc:…"
  // or "%N"), which clobbers any exported backend override in its env — so a
  // child instead *inherits* the backend its parent actually resolved, taken
  // from the id prefix. That is also what keeps nested spawns consistent: a
  // headless child's grandchild stays headless even when the child inherits
  // TMUX/TMUX_PANE from a parent that runs inside tmux.
  const envSurface = process.env.PI_SUBAGENT_SURFACE?.trim();
  if (envSurface === "rpc" || envSurface === "tmux" || envSurface === "auto") {
    backend = envSurface;
  } else if (envSurface?.startsWith("rpc:")) {
    backend = "rpc"; // we ARE a headless child — our spawns stay headless
  } else if (envSurface?.startsWith("%")) {
    backend = "tmux"; // we ARE a pane child — our spawns open panes
  }
  const envPanes = process.env.PI_SUBAGENT_PANES?.trim();
  if (envPanes === "0" || envPanes === "false") panesEnabled = false;
  if (envPanes === "1" || envPanes === "true") panesEnabled = true;

  return { backend, panesEnabled };
}

/**
 * Resolve the concrete backend for a spawn.
 *
 *   env PI_SUBAGENT_SURFACE > config "tmux"/"rpc" > "auto"
 *
 * "auto" keeps the historical behavior inside tmux and goes headless outside
 * of it — that is what removes the tmux requirement for environments (like
 * pi-learn's md-log flow) that never wanted a multiplexer in the first place.
 * Claude-CLI agents always use tmux: the claude CLI has no RPC mode, so an
 * explicit request for them without tmux fails with the standard hint.
 */
export function resolveSurfaceBackend(
  agentType?: "pi" | "claude",
  config: SurfaceConfig = loadSurfaceConfig(),
): SurfaceBackend {
  if (agentType === "claude") return "tmux";
  if (config.backend === "tmux") return "tmux";
  if (config.backend === "rpc") return "rpc";
  return isTmuxAvailable() ? "tmux" : "rpc";
}

// ── Id-prefix dispatch ───────────────────────────────────────────────────────

export function isRpcSurface(surfaceId: string): boolean {
  return typeof surfaceId === "string" && surfaceId.startsWith("rpc:");
}

/** Send a message into a running child, whatever surface it lives on. */
export function sendSurfaceCommand(surfaceId: string, command: string): void {
  if (isRpcSurface(surfaceId)) {
    sendRpcCommand(surfaceId, command);
  } else {
    sendTmuxCommand(surfaceId, command);
  }
}

/** Close a surface (kill pane / process group). */
export function closeSurfaceAny(surfaceId: string): void {
  if (isRpcSurface(surfaceId)) {
    closeRpcSurface(surfaceId);
  } else {
    closeTmuxSurface(surfaceId);
  }
}

/** Read a surface's last rendered lines (transcript buffer for rpc children). */
export function readSurfaceScreen(surfaceId: string, lines = 50): string {
  if (isRpcSurface(surfaceId)) {
    // Same semantics as tmux's readScreen for a gone pane: "" not a throw.
    return readRpcScreen(surfaceId, lines);
  }
  return readTmuxScreen(surfaceId, lines);
}

export interface SurfacePollOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsed: number) => void;
}

/**
 * Poll a surface until its child exits. Signature-compatible with the
 * original tmux-only pollForExit so watchSubagent needed no changes beyond
 * the call target: same options, same PollResult, same 1s tick cadence
 * (status observation + question delivery ride the onTick callback).
 */
export function pollSurfaceForExit(
  surfaceId: string,
  signal: AbortSignal,
  options: SurfacePollOptions,
): Promise<PollResult> {
  if (isRpcSurface(surfaceId)) {
    return pollRpcForExit(surfaceId, signal, options);
  }
  return pollTmuxForExit(surfaceId, signal, options);
}

export type { PollResult };