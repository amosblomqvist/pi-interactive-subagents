import { execFile } from "node:child_process";
import { dirname, posix, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitizeMonitorText, type SubagentMonitorEvent } from "./monitor.ts";

export type ViewerShell = "posix" | "powershell";

export interface ViewerTarget {
  id: string;
  name: string;
  snapshotFile: string;
  callerCwd: string;
  /** Becomes false when the Pi session that initiated the click retires. */
  isCurrent?: () => boolean;
}

export interface ViewerSnapshot {
  id: string;
  parentId: string | null;
  name: string;
  agent: string | null;
  depth: number;
  status: string;
  elapsed: string;
  terminal?: boolean;
  events: SubagentMonitorEvent[];
}

export interface HerdrExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type HerdrExec = (command: string, args: string[]) => Promise<HerdrExecResult>;

function defaultExec(command: string, args: string[]): Promise<HerdrExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number"
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : error ? 1 : 0,
      });
    });
  });
}

function rejectControls(value: string, label: string): void {
  if (/\0|\r|\n/u.test(value)) throw new Error(`${label} contains an unsafe control character.`);
}

function posixQuote(value: string): string {
  rejectControls(value, "Viewer argument");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value: string): string {
  rejectControls(value, "Viewer argument");
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsPathForPosixShell(value: string): string {
  // Git Bash/MSYS accepts drive-qualified forward-slash paths directly. Using
  // /c/... here triggers MSYS argument conversion into C:\\c\\... for native
  // executables in some installations.
  return value.replaceAll("\\", "/");
}

/**
 * Resolve quoting only when the pane shell is explicit or unambiguous.
 * cmd.exe is deliberately unsupported because `%VAR%` expands inside quotes.
 */
export function resolveViewerShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ViewerShell {
  const explicit = env.PI_SUBAGENT_HERDR_SHELL?.trim().toLowerCase();
  if (explicit) {
    if (["bash", "sh", "zsh", "posix", "git-bash"].includes(explicit)) return "posix";
    if (["powershell", "pwsh"].includes(explicit)) return "powershell";
    if (["cmd", "cmd.exe"].includes(explicit)) {
      throw new Error("cmd.exe is not supported for the Herdr viewer because percent expansion cannot safely preserve arbitrary paths.");
    }
    throw new Error(`Unsupported PI_SUBAGENT_HERDR_SHELL value: ${explicit}`);
  }
  if (platform !== "win32") return "posix";
  const shell = env.SHELL?.trim().toLowerCase() ?? "";
  if (/(?:^|[\\/])(bash|sh|zsh)(?:\.exe)?$/u.test(shell)) return "posix";
  throw new Error(
    "Cannot safely determine the Herdr pane shell on Windows. Set PI_SUBAGENT_HERDR_SHELL=powershell or git-bash; cmd.exe is unsupported.",
  );
}

export function buildViewerCommand(params: {
  platform: NodeJS.Platform;
  shell: ViewerShell;
  nodeExecutable: string;
  viewerScript: string;
  snapshotFile: string;
}): string {
  const isAbsolute = params.platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  if (!isAbsolute(params.nodeExecutable)) {
    throw new Error("Herdr viewer requires an absolute Node executable path; bare node PATH fallback is refused.");
  }
  if (params.shell === "powershell") {
    if (params.platform !== "win32") throw new Error("PowerShell viewer quoting is supported only on Windows.");
    return `& ${[params.nodeExecutable, params.viewerScript, params.snapshotFile].map(powershellQuote).join(" ")}`;
  }
  const values = params.platform === "win32"
    ? [params.nodeExecutable, params.viewerScript, params.snapshotFile].map(windowsPathForPosixShell)
    : [params.nodeExecutable, params.viewerScript, params.snapshotFile];
  return values.map(posixQuote).join(" ");
}

function parseCreation(stdout: string): { tabId: string; paneId: string } {
  let value: any;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Herdr tab create returned invalid JSON.");
  }
  const tabId = value?.result?.tab?.tab_id;
  const paneId = value?.result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || typeof paneId !== "string") {
    throw new Error("Herdr tab create did not return tab and root pane IDs.");
  }
  return { tabId, paneId };
}

function commandError(action: string, result: HerdrExecResult): Error {
  const detail = sanitizeMonitorText(result.stderr || result.stdout, 300) || `exit ${result.code}`;
  return new Error(`Herdr ${action} failed: ${detail}`);
}

function requestCurrent(target: ViewerTarget): boolean {
  return target.isCurrent?.() !== false;
}

export class HerdrViewerManager {
  private readonly exec: HerdrExec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  private readonly nodeExecutable: string;
  private readonly viewerScript: string;
  private readonly shell?: ViewerShell;
  private readonly tabs = new Map<string, string>();
  private readonly opening = new Map<string, Promise<void>>();

  constructor(options: {
    exec?: HerdrExec;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    executable?: string;
    nodeExecutable?: string;
    viewerScript?: string;
    shell?: ViewerShell;
  } = {}) {
    this.exec = options.exec ?? defaultExec;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? this.env.PI_SUBAGENT_HERDR_EXECUTABLE ?? "herdr";
    // process.execPath is already resolved by the running Pi process. Never
    // silently fall back to a shell-dependent bare `node` command.
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.viewerScript = options.viewerScript ?? fileURLToPath(new URL("./viewer-runtime.mjs", import.meta.url));
    this.shell = options.shell;
  }

  available(): boolean {
    return this.env.HERDR_ENV === "1";
  }

  async openOrFocus(target: ViewerTarget): Promise<void> {
    if (!this.available()) {
      throw new Error("This Pi session is not running inside Herdr; use Ctrl+Alt+S for the built-in read-only monitor.");
    }
    const workspace = this.env.HERDR_WORKSPACE_ID?.trim();
    if (!workspace) throw new Error("Herdr viewer requires the caller's explicit HERDR_WORKSPACE_ID; refusing UI-focused workspace fallback.");
    const callerCwdIsAbsolute = !!target.callerCwd && (
      this.platform === "win32" ? win32.isAbsolute(target.callerCwd) : posix.isAbsolute(target.callerCwd)
    );
    if (!callerCwdIsAbsolute) {
      throw new Error("Herdr viewer requires the caller's absolute working directory.");
    }
    if (!requestCurrent(target)) throw new Error("Herdr viewer request belongs to a retired Pi session.");

    const existing = this.tabs.get(target.id);
    if (existing) {
      if (!requestCurrent(target)) throw new Error("Herdr viewer request belongs to a retired Pi session.");
      const focused = await this.exec(this.executable, ["tab", "focus", existing]);
      if (focused.code === 0) return;
      this.tabs.delete(target.id);
      if (!requestCurrent(target)) throw new Error("Herdr viewer request belongs to a retired Pi session.");
    }

    const inFlight = this.opening.get(target.id);
    if (inFlight) return inFlight;
    const operation = this.createViewer(target, workspace).finally(() => this.opening.delete(target.id));
    this.opening.set(target.id, operation);
    return operation;
  }

  private async closeCreatedTab(tabId: string): Promise<void> {
    await this.exec(this.executable, ["tab", "close", tabId]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  }

  private async createViewer(target: ViewerTarget, workspace: string): Promise<void> {
    const label = `Subagent ${sanitizeMonitorText(target.name, 48) || target.id}`;
    const createArgs = [
      "tab", "create",
      "--workspace", workspace,
      "--cwd", target.callerCwd,
      "--label", label,
      "--no-focus",
    ];
    const created = await this.exec(this.executable, createArgs);
    if (created.code !== 0) throw commandError("tab create", created);
    const { tabId, paneId } = parseCreation(created.stdout);

    try {
      if (!requestCurrent(target)) throw new Error("Herdr viewer request belongs to a retired Pi session.");
      const viewerCommand = buildViewerCommand({
        platform: this.platform,
        shell: this.shell ?? resolveViewerShell(this.platform, this.env),
        nodeExecutable: this.nodeExecutable,
        viewerScript: this.viewerScript,
        snapshotFile: target.snapshotFile,
      });
      const ran = await this.exec(this.executable, ["pane", "run", paneId, viewerCommand]);
      if (ran.code !== 0) throw commandError("pane run", ran);
      if (!requestCurrent(target)) throw new Error("Herdr viewer request belongs to a retired Pi session.");
      this.tabs.set(target.id, tabId);
      const focused = await this.exec(this.executable, ["tab", "focus", tabId]);
      if (focused.code !== 0) {
        this.tabs.delete(target.id);
        throw commandError("tab focus", focused);
      }
    } catch (error) {
      this.tabs.delete(target.id);
      // This exact tab ID came from this create call; never close a focused or
      // discovered tab that the manager did not create itself.
      await this.closeCreatedTab(tabId);
      throw error;
    }
  }
}

export function writeViewerSnapshot(file: string, snapshot: ViewerSnapshot): void {
  const safe = {
    version: 1,
    updatedAt: Date.now(),
    terminal: snapshot.terminal === true,
    id: sanitizeMonitorText(snapshot.id, 100),
    parentId: snapshot.parentId ? sanitizeMonitorText(snapshot.parentId, 100) : null,
    name: sanitizeMonitorText(snapshot.name, 100),
    agent: snapshot.agent ? sanitizeMonitorText(snapshot.agent, 100) : null,
    depth: Math.max(0, Math.min(100, Math.floor(snapshot.depth))),
    status: sanitizeMonitorText(snapshot.status, 120),
    elapsed: sanitizeMonitorText(snapshot.elapsed, 40),
    events: snapshot.events.slice(-20).map((event) => ({
      kind: event.kind,
      text: sanitizeMonitorText(event.text, 240),
      ...(event.timestamp ? { timestamp: sanitizeMonitorText(event.timestamp, 80) } : {}),
    })),
  };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
