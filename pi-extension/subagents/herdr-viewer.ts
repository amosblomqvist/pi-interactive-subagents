import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeMonitorText, type SubagentMonitorEvent } from "./monitor.ts";

export interface ViewerTarget {
  id: string;
  name: string;
  snapshotFile: string;
}

export interface ViewerSnapshot {
  id: string;
  parentId: string | null;
  name: string;
  agent: string | null;
  depth: number;
  status: string;
  elapsed: string;
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

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsQuote(value: string): string {
  if (value.includes('"') || /[\r\n\0]/u.test(value)) {
    throw new Error("Viewer path contains an unsafe quote or control character.");
  }
  return `"${value}"`;
}

export function buildViewerCommand(params: {
  platform: NodeJS.Platform;
  nodeExecutable: string;
  viewerScript: string;
  snapshotFile: string;
}): string {
  if (params.platform === "win32") {
    const executable = /^[A-Za-z0-9_.:-]+$/u.test(params.nodeExecutable)
      ? params.nodeExecutable
      : windowsQuote(params.nodeExecutable);
    return [executable, windowsQuote(params.viewerScript), windowsQuote(params.snapshotFile)].join(" ");
  }
  return [params.nodeExecutable, params.viewerScript, params.snapshotFile].map(posixQuote).join(" ");
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

export class HerdrViewerManager {
  private readonly exec: HerdrExec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly executable: string;
  private readonly nodeExecutable: string;
  private readonly viewerScript: string;
  private readonly tabs = new Map<string, string>();
  private readonly opening = new Map<string, Promise<void>>();

  constructor(options: {
    exec?: HerdrExec;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    executable?: string;
    nodeExecutable?: string;
    viewerScript?: string;
  } = {}) {
    this.exec = options.exec ?? defaultExec;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.executable = options.executable ?? this.env.PI_SUBAGENT_HERDR_EXECUTABLE ?? "herdr";
    // A bare `node` invocation is understood by PowerShell, cmd, and Git Bash;
    // a quoted executable path is not a command expression in PowerShell.
    this.nodeExecutable = options.nodeExecutable ?? (this.platform === "win32" ? "node" : process.execPath);
    this.viewerScript = options.viewerScript ?? fileURLToPath(new URL("./viewer-runtime.mjs", import.meta.url));
  }

  available(): boolean {
    return this.env.HERDR_ENV === "1";
  }

  async openOrFocus(target: ViewerTarget): Promise<void> {
    if (!this.available()) {
      throw new Error("This Pi session is not running inside Herdr; use Ctrl+Alt+S for the built-in read-only monitor.");
    }
    const existing = this.tabs.get(target.id);
    if (existing) {
      const focused = await this.exec(this.executable, ["tab", "focus", existing]);
      if (focused.code === 0) return;
      this.tabs.delete(target.id);
    }

    const inFlight = this.opening.get(target.id);
    if (inFlight) return inFlight;
    const operation = this.createViewer(target).finally(() => this.opening.delete(target.id));
    this.opening.set(target.id, operation);
    return operation;
  }

  private async createViewer(target: ViewerTarget): Promise<void> {
    const label = `Subagent ${sanitizeMonitorText(target.name, 48) || target.id}`;
    const createArgs = ["tab", "create"];
    const workspace = this.env.HERDR_WORKSPACE_ID?.trim();
    if (workspace) createArgs.push("--workspace", workspace);
    createArgs.push("--cwd", dirname(target.snapshotFile), "--label", label, "--no-focus");
    const created = await this.exec(this.executable, createArgs);
    if (created.code !== 0) throw commandError("tab create", created);
    const { tabId, paneId } = parseCreation(created.stdout);

    try {
      const viewerCommand = buildViewerCommand({
        platform: this.platform,
        nodeExecutable: this.nodeExecutable,
        viewerScript: this.viewerScript,
        snapshotFile: target.snapshotFile,
      });
      const ran = await this.exec(this.executable, ["pane", "run", paneId, viewerCommand]);
      if (ran.code !== 0) throw commandError("pane run", ran);
      this.tabs.set(target.id, tabId);
      const focused = await this.exec(this.executable, ["tab", "focus", tabId]);
      if (focused.code !== 0) {
        this.tabs.delete(target.id);
        throw commandError("tab focus", focused);
      }
    } catch (error) {
      await this.exec(this.executable, ["tab", "close", tabId]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
      throw error;
    }
  }
}

export function writeViewerSnapshot(file: string, snapshot: ViewerSnapshot): void {
  const safe = {
    version: 1,
    updatedAt: Date.now(),
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
