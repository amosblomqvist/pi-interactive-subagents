import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  HerdrViewerManager,
  buildViewerCommand,
  resolveViewerShell,
  writeViewerSnapshot,
} from "../pi-extension/subagents/herdr-viewer.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-herdr-viewer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc123",
    name: "Worker & audit",
    snapshotFile: "C:\\safe path\\abc123.json",
    callerCwd: "C:\\caller project",
    ...overrides,
  } as any;
}

function fakeCreation(tab = "w1:t9", pane = "w1:p9") {
  return JSON.stringify({ result: { tab: { tab_id: tab }, root_pane: { pane_id: pane } } });
}

test("concurrent opens create one caller-scoped read-only tab and later clicks only focus it", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "tab" && args[1] === "create") {
      return { stdout: fakeCreation(), stderr: "", code: 0 };
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0 };
  };
  const manager = new HerdrViewerManager({
    exec,
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    platform: "win32",
    shell: "powershell",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    viewerScript: "C:\\safe path\\viewer-runtime.mjs",
  });

  await Promise.all([manager.openOrFocus(target()), manager.openOrFocus(target())]);
  await manager.openOrFocus(target());

  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "tab create").length, 1);
  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "pane run").length, 1);
  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "tab focus").length, 2);
  const create = calls.find((call) => call.args[0] === "tab" && call.args[1] === "create")!;
  assert.deepEqual(create.args.slice(2), [
    "--workspace", "w1", "--cwd", "C:\\caller project", "--label", "Subagent Worker & audit", "--no-focus",
  ]);
  const run = calls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
  assert.equal(run.args[2], "w1:p9");
  assert.match(run.args[3]!, /^& 'C:\\Program Files\\nodejs\\node\.exe' /);
  assert.doesNotMatch(run.args[3]!, /Worker & audit/);
});

test("missing caller Herdr workspace fails closed without UI-focused fallback", async () => {
  let calls = 0;
  const manager = new HerdrViewerManager({
    exec: async () => { calls++; return { stdout: "", stderr: "", code: 0 }; },
    env: { HERDR_ENV: "1" },
    platform: "win32",
    shell: "powershell",
  });
  await assert.rejects(manager.openOrFocus(target()), /explicit HERDR_WORKSPACE_ID/i);
  assert.equal(calls, 0);
});

test("absent Herdr is a clear non-mutating fallback", async () => {
  let calls = 0;
  const manager = new HerdrViewerManager({
    exec: async () => { calls++; return { stdout: "", stderr: "", code: 0 }; },
    env: {},
    platform: "win32",
    shell: "powershell",
  });
  await assert.rejects(manager.openOrFocus(target()), /not running inside Herdr/i);
  assert.equal(calls, 0);
});

test("failed create/run is retryable and closes only the tab created by that attempt", async () => {
  let creates = 0;
  let runs = 0;
  const closed: string[] = [];
  const manager = new HerdrViewerManager({
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    platform: "win32",
    shell: "powershell",
    exec: async (_command, args) => {
      if (args[0] === "tab" && args[1] === "create") {
        creates++;
        return { stdout: fakeCreation(`w1:t${creates}`, `w1:p${creates}`), stderr: "", code: 0 };
      }
      if (args[0] === "pane" && args[1] === "run") {
        runs++;
        if (runs === 1) return { stdout: "", stderr: "run failed", code: 1 };
      }
      if (args[0] === "tab" && args[1] === "close") closed.push(args[2]!);
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  await assert.rejects(manager.openOrFocus(target({ id: "a" })), /run failed/i);
  await manager.openOrFocus(target({ id: "a" }));
  assert.equal(creates, 2);
  assert.equal(runs, 2);
  assert.deepEqual(closed, ["w1:t1"]);
});

test("retired request closes its newly created tab and never runs or focuses", async () => {
  let resolveCreate!: (result: any) => void;
  let current = true;
  const calls: string[][] = [];
  const manager = new HerdrViewerManager({
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    platform: "win32",
    shell: "powershell",
    exec: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "tab" && args[1] === "create") {
        return new Promise((resolve) => { resolveCreate = resolve; });
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const opening = manager.openOrFocus(target({ isCurrent: () => current }));
  current = false;
  resolveCreate({ stdout: fakeCreation(), stderr: "", code: 0 });
  await assert.rejects(opening, /retired Pi session/i);
  assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "run"), false);
  assert.equal(calls.some((args) => args[0] === "tab" && args[1] === "focus"), false);
  assert.deepEqual(calls.find((args) => args[0] === "tab" && args[1] === "close"), ["tab", "close", "w1:t9"]);
});

test("retirement while pane run is pending prevents late focus and cleans the created tab", async () => {
  let resolveRun!: (result: any) => void;
  let current = true;
  const calls: string[][] = [];
  const manager = new HerdrViewerManager({
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    platform: "win32",
    shell: "powershell",
    exec: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "tab" && args[1] === "create") return { stdout: fakeCreation(), stderr: "", code: 0 };
      if (args[0] === "pane" && args[1] === "run") return new Promise((resolve) => { resolveRun = resolve; });
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const opening = manager.openOrFocus(target({ isCurrent: () => current }));
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  resolveRun({ stdout: "{}", stderr: "", code: 0 });
  await assert.rejects(opening, /retired Pi session/i);
  assert.equal(calls.some((args) => args[0] === "tab" && args[1] === "focus"), false);
  assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t9"]);
});

test("shell resolution is explicit and bare Node fallback is refused", () => {
  assert.equal(resolveViewerShell("linux", {}), "posix");
  assert.equal(resolveViewerShell("win32", { SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" }), "posix");
  assert.equal(resolveViewerShell("win32", { PI_SUBAGENT_HERDR_SHELL: "powershell" }), "powershell");
  assert.throws(() => resolveViewerShell("win32", {}), /cannot safely determine/i);
  assert.throws(() => resolveViewerShell("win32", { PI_SUBAGENT_HERDR_SHELL: "cmd" }), /cmd\.exe is not supported/i);
  assert.throws(() => buildViewerCommand({
    platform: "win32", shell: "powershell", nodeExecutable: "node.exe", viewerScript: "safe", snapshotFile: "safe",
  }), /absolute Node executable.*bare node/i);
});

test("emitted commands preserve adversarial synthetic paths in installed PowerShell and Git Bash", (t) => {
  if (process.platform !== "win32") return t.skip("Windows shell compatibility test");
  const dir = fixture(t);
  const adversarialDir = join(dir, "viewer-$()-`-%TEMP%-&-'safe");
  mkdirSync(adversarialDir, { recursive: true });
  const script = join(adversarialDir, "sentinel viewer.mjs");
  const snapshot = join(adversarialDir, "snapshot-$()-`-%PATH%.json");
  const sentinel = join(dir, "observed.txt");
  writeFileSync(snapshot, "{}", "utf8");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, process.argv[2], "utf8");\n`, "utf8");

  const powershellCommand = buildViewerCommand({
    platform: "win32", shell: "powershell", nodeExecutable: process.execPath, viewerScript: script, snapshotFile: snapshot,
  });
  const powershell = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellCommand],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(powershell.status, 0, powershell.stderr || powershell.stdout);
  assert.equal(resolve(readFileSync(sentinel, "utf8")), resolve(snapshot));

  rmSync(sentinel, { force: true });
  const bashCommand = buildViewerCommand({
    platform: "win32", shell: "posix", nodeExecutable: process.execPath, viewerScript: script, snapshotFile: snapshot,
  });
  const bash = spawnSync("bash.exe", ["-lc", bashCommand], { encoding: "utf8", windowsHide: true });
  assert.equal(bash.status, 0, bash.stderr || bash.stdout);
  assert.equal(resolve(readFileSync(sentinel, "utf8")), resolve(snapshot));
});

test("viewer runtime renders terminal snapshots as disconnected without Pi attachment", async (t) => {
  const dir = fixture(t);
  const file = join(dir, "terminal.json");
  writeViewerSnapshot(file, {
    id: "terminal-child", parentId: null, name: "worker", agent: "worker", depth: 1,
    status: "completed", elapsed: "7s", terminal: true, events: [],
  });
  const viewerScript = new URL("../pi-extension/subagents/viewer-runtime.mjs", import.meta.url);
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(viewerScript), file], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let combined = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`viewer runtime timed out: ${combined}`));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      combined += chunk.toString("utf8");
      if (!combined.includes("connection: disconnected")) return;
      clearTimeout(timer);
      child.kill();
      resolveOutput(combined);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
  });
  assert.match(output, /status: completed/);
  assert.match(output, /connection: disconnected/);
  assert.doesNotMatch(output, /attach|model invocation/i);
});

test("viewer snapshots are terminal-aware, bounded, sanitized, and contain no reasoning or credentials", (t) => {
  const dir = fixture(t);
  const file = join(dir, "viewer.json");
  writeViewerSnapshot(file, {
    id: "abc",
    parentId: null,
    name: "\u001b[31mworker\u001b[0m",
    agent: "worker",
    depth: 1,
    status: "completed",
    elapsed: "5s",
    terminal: true,
    events: [
      { kind: "assistant", text: "visible status" },
      { kind: "tool", text: "curl https://example.com?api_key=super-secret" },
      { kind: "error", text: "provider rejected sk-proj-abcdefghijklmnop" },
      { kind: "assistant", text: "x".repeat(10_000) },
    ],
  });
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.terminal, true);
  assert.ok(Buffer.byteLength(raw) < 16_000);
  assert.doesNotMatch(raw, /\u001b|super-secret|sk-proj-abcdefghijklmnop/);
  assert.match(raw, /redacted/);
  assert.doesNotMatch(raw, /thinking|reasoning/i);
});
