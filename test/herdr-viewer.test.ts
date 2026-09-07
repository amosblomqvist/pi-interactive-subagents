import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HerdrViewerManager,
  buildViewerCommand,
  writeViewerSnapshot,
} from "../pi-extension/subagents/herdr-viewer.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-herdr-viewer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("concurrent opens create one read-only tab and later clicks only focus it", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "tab" && args[1] === "create") {
      return { stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } }), stderr: "", code: 0 };
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0 };
  };
  const manager = new HerdrViewerManager({
    exec,
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    viewerScript: "C:\\safe path\\viewer-runtime.mjs",
  });
  const target = { id: "abc123", name: "Worker & audit", snapshotFile: "C:\\safe path\\abc123.json" };

  await Promise.all([manager.openOrFocus(target), manager.openOrFocus(target)]);
  await manager.openOrFocus(target);

  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "tab create").length, 1);
  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "pane run").length, 1);
  assert.equal(calls.filter((call) => call.args.slice(0, 2).join(" ") === "tab focus").length, 2);
  const run = calls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
  assert.equal(run.args[2], "w1:p9");
  assert.match(run.args[3]!, /^"C:\\Program Files\\nodejs\\node\.exe" /);
  assert.doesNotMatch(run.args[3]!, /Worker & audit/);
});

test("absent Herdr is a clear non-mutating fallback", async () => {
  let calls = 0;
  const manager = new HerdrViewerManager({
    exec: async () => { calls++; return { stdout: "", stderr: "", code: 0 }; },
    env: {},
  });
  await assert.rejects(
    manager.openOrFocus({ id: "a", name: "worker", snapshotFile: "safe.json" }),
    /not running inside Herdr/i,
  );
  assert.equal(calls, 0);
});

test("failed create/run is retryable and does not cache a broken tab", async () => {
  let creates = 0;
  let runs = 0;
  const manager = new HerdrViewerManager({
    env: { HERDR_ENV: "1" },
    exec: async (_command, args) => {
      if (args[0] === "tab" && args[1] === "create") {
        creates++;
        return { stdout: JSON.stringify({ result: { tab: { tab_id: `w1:t${creates}` }, root_pane: { pane_id: `w1:p${creates}` } } }), stderr: "", code: 0 };
      }
      if (args[0] === "pane" && args[1] === "run") {
        runs++;
        if (runs === 1) return { stdout: "", stderr: "run failed", code: 1 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });
  const target = { id: "a", name: "worker", snapshotFile: "safe.json" };
  await assert.rejects(manager.openOrFocus(target), /run failed/i);
  await manager.openOrFocus(target);
  assert.equal(creates, 2);
  assert.equal(runs, 2);
});

test("viewer command quotes trusted paths safely on Windows and POSIX", () => {
  const windows = buildViewerCommand({
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    viewerScript: "C:\\viewer & tools\\viewer-runtime.mjs",
    snapshotFile: "C:\\artifacts\\row (1).json",
  });
  assert.equal(
    windows,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\viewer & tools\\viewer-runtime.mjs" "C:\\artifacts\\row (1).json"',
  );
  assert.throws(() => buildViewerCommand({
    platform: "win32", nodeExecutable: "node.exe", viewerScript: "bad\"path", snapshotFile: "safe",
  }), /unsafe quote/i);

  const posix = buildViewerCommand({
    platform: "linux", nodeExecutable: "/opt/node", viewerScript: "/tmp/viewer's runtime.mjs", snapshotFile: "/tmp/a b.json",
  });
  assert.equal(posix, "'/opt/node' '/tmp/viewer'\\''s runtime.mjs' '/tmp/a b.json'");
});

test("viewer snapshots are bounded, sanitized, and contain no reasoning or credentials", (t) => {
  const dir = fixture(t);
  const file = join(dir, "viewer.json");
  writeViewerSnapshot(file, {
    id: "abc",
    parentId: null,
    name: "\u001b[31mworker\u001b[0m",
    agent: "worker",
    depth: 1,
    status: "active",
    elapsed: "5s",
    events: [
      { kind: "assistant", text: "visible status" },
      { kind: "tool", text: "curl https://example.com?api_key=super-secret" },
      { kind: "error", text: "provider rejected sk-proj-abcdefghijklmnop" },
      { kind: "assistant", text: "x".repeat(10_000) },
    ],
  });
  const raw = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(raw) < 16_000);
  assert.doesNotMatch(raw, /\u001b|super-secret|sk-proj-abcdefghijklmnop/);
  assert.match(raw, /redacted/);
  assert.doesNotMatch(raw, /thinking|reasoning/i);
});
