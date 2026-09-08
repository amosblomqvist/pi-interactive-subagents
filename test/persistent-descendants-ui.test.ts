import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../pi-extension/subagents/index.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import { loadRuntimeConfig, parseRuntimeConfig } from "../pi-extension/subagents/runtime-config.ts";
import { loadStatusConfig } from "../pi-extension/subagents/status.ts";
import { createBackgroundSurface, sendLongCommand, withExitSentinel } from "../pi-extension/subagents/surface.ts";
import { DEFAULT_DELEGATION_LIMITS, ensureLineageLedger, readLineageLedger, reserveLineageLaunch } from "../pi-extension/subagents/lineage.ts";

function agent(id: string, parentId: string | null, depth: number, name = "worker") {
  return {
    id,
    parentId,
    depth,
    name,
    task: "task",
    agent: "worker",
    surface: `process:${id}`,
    startTime: 1_000 + depth,
    sessionFile: `${id}.jsonl`,
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: 1_000 }),
  };
}

const theme = {
  fg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
} as any;

test("monitor tree uses stable IDs and collapses descendants without name-based identity", () => {
  const root = agent("id-root", null, 1, "worker");
  const child = agent("id-child", "id-root", 2, "worker");
  const grandchild = agent("id-grandchild", "id-child", 3, "worker");
  const sibling = agent("id-sibling", null, 1, "worker");

  assert.deepEqual(
    __test__.flattenMonitorTree([grandchild, child, sibling, root], new Set(["id-root", "id-child", "id-sibling"])).map((item: any) => item.id),
    ["id-root", "id-child", "id-grandchild", "id-sibling"],
  );
  assert.deepEqual(
    __test__.flattenMonitorTree([grandchild, child, sibling, root], new Set(["id-sibling"])).map((item: any) => item.id),
    ["id-root", "id-sibling"],
  );
  const rendered = __test__.renderSubagentMonitorLines(
    [root, child, sibling],
    "id-child",
    100,
    theme,
    new Set(["id-root", "id-sibling"]),
  ).join("\n");
  assert.match(rendered, /worker.*\[id-root\]/);
  assert.match(rendered, /worker.*\[id-child\]/);
  assert.match(rendered, /depth 2/);
  assert.match(
    __test__.renderSubagentWidgetLines(__test__.flattenMonitorTree([child, sibling, root]), 140).join("\n"),
    /\[id-root\].*↳1/,
  );

  const cycleA = agent("cycle-a", "cycle-b", 1);
  const cycleB = agent("cycle-b", "cycle-a", 2);
  assert.deepEqual(
    __test__.flattenMonitorTree([cycleA, cycleB]).map((item: any) => item.id),
    ["cycle-a", "cycle-b"],
  );
});

test("fullscreen widget click addresses the stable row ID and ordinary presses remain unhandled", () => {
  let component: any;
  let clicked: any;
  const agents = [agent("first", null, 1), agent("second", null, 1)];
  __test__.syncSubagentStatusWidget(
    {
      setWidget(_key: string, factory: any) {
        component = factory({ requestRender() {} });
      },
    },
    { installed: false, tui: null },
    () => agents,
    (selected: any) => { clicked = selected; },
  );

  component.render(80);
  agents.unshift(agent("new-between-render-and-click", null, 1));
  const base = { x: 2, screenX: 2, screenY: 2, width: 80, height: 4, shift: false, alt: false, ctrl: false };
  assert.equal(component.handleMouse({ ...base, type: "press", button: "left", y: 2 }), undefined);
  assert.equal(clicked, undefined);
  assert.deepEqual(component.handleMouse({ ...base, type: "click", button: "left", y: 2 }), { handled: true });
  assert.equal(clicked.id, "second");

  let throwingComponent: any;
  __test__.syncSubagentStatusWidget(
    { setWidget(_key: string, factory: any) { throwingComponent = factory({ requestRender() {} }); } },
    { installed: false, tui: null },
    () => [agent("safe-click", null, 1)],
    () => { throw new Error("synthetic snapshot failure"); },
  );
  throwingComponent.render(80);
  assert.doesNotThrow(() => throwingComponent.handleMouse({ ...base, type: "click", button: "left", y: 1 }));
});

test("synthetic descendant fallback uses bounded activity instead of browsing its session", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-owned-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "unowned-session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "SECRET SESSION CONTENT" }] },
  }));
  const synthetic: any = {
    ...agent("synthetic-child", "parent", 2),
    sessionFile,
    lineageFile: join(dir, "subagent-lineage.json"),
    activity: {
      version: 1,
      runningChildId: "synthetic-child",
      createdAt: 1,
      updatedAt: 2,
      sequence: 1,
      latestEvent: "tool_call",
      phase: "active",
      agentActive: true,
      turnActive: true,
      providerActive: false,
      toolActive: true,
      toolName: "read",
      toolSummary: "owned-file.ts",
    },
  };
  const events = __test__.observableEventsFor(synthetic, 16);
  assert.match(JSON.stringify(events), /owned-file\.ts/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET SESSION CONTENT/);

  const snapshotFile = __test__.writeAgentViewerSnapshot(synthetic, {
    status: "completed",
    terminal: true,
    events,
  });
  assert.equal(JSON.parse(readFileSync(snapshotFile, "utf8")).terminal, true);
});

test("completed process writes a terminal viewer snapshot before releasing its lease", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-terminal-lifecycle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lineageFile = join(dir, "subagent-lineage.json");
  const id = "terminal-owner";
  const activityFile = join(dir, "subagent-activity", `${id}.json`);
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", id: "terminal-session", cwd: dir }),
    JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n") + "\n");
  await ensureLineageLedger(lineageFile, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  const lease = await reserveLineageLaunch(lineageFile, {
    id, parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile, activityFile, ownerPid: process.pid, task: "finish", kind: "launch",
  });
  const surface = createBackgroundSurface();
  sendLongCommand(surface, withExitSentinel("printf 'observable completion\\n'"), {
    scriptPath: join(dir, "terminal-owner.sh"),
  });
  const running: any = {
    id, parentId: null, depth: 1, name: "worker", task: "finish", agent: "worker",
    surface, startTime: Date.now(), sessionFile, activityFile, interactive: false,
    lineageFile, lineageToken: lease.token,
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
  };
  __test__.runningSubagents.set(id, running);
  const result = await __test__.watchSubagent(running, new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.equal(Object.keys(readLineageLedger(lineageFile)!.active).length, 0);
  const terminal = JSON.parse(readFileSync(join(dir, "subagent-viewers", `${id}.json`), "utf8"));
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.status, "completed");
  assert.equal(__test__.runningSubagents.has(id), false);
});

test("failed surface termination retains lineage capacity", () => {
  const failure = new Error("synthetic taskkill failure");
  assert.deepEqual(
    __test__.closeSurfaceForLineage("process:test", () => { throw failure; }),
    { releaseLease: false, error: failure },
  );
  assert.deepEqual(
    __test__.closeSurfaceForLineage("process:test", () => {}),
    { releaseLease: true },
  );
});

test("runtime config defaults cumulative launches to unlimited and accepts legacy finite caps", () => {
  assert.deepEqual(parseRuntimeConfig({ status: { enabled: true } }), {
    delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: null },
    herdrViewer: { enabled: true },
  });
  assert.deepEqual(
    parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: null } }).delegation,
    { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: null },
  );
  assert.deepEqual(
    parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: 12 } }).delegation,
    { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: 12 },
  );
  assert.throws(
    () => parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: -1 } }),
    /maxLaunchesPerLineage/,
  );
  assert.throws(
    () => parseRuntimeConfig({ delegation: { maxDepth: null, maxConcurrentDescendants: 4, maxLaunchesPerLineage: null } }),
    /maxDepth/,
  );
  assert.throws(
    () => parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: null, dollars: 1 } }),
    /unsupported key.*dollars/,
  );
});

test("unlimited launch usage display is explicit without a numeric denominator", () => {
  const rendered = __test__.formatLineageLaunchUsage({ used: 14, limit: null });
  assert.equal(rendered, "14 launches · unlimited");
  assert.doesNotMatch(rendered, /\/null|\/12/);
  assert.equal(__test__.formatLineageLaunchUsage({ used: 3, limit: 12 }), "3/12 launches");
});

test("absolute external config is shared by runtime and status without package mutation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-external-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    status: { enabled: false },
    delegation: { maxDepth: 3, maxConcurrentDescendants: 5, maxLaunchesPerLineage: 20 },
    herdrViewer: { enabled: false },
  }));
  const env = { PI_SUBAGENTS_CONFIG: file };
  assert.deepEqual(loadRuntimeConfig(undefined, undefined, env), {
    delegation: { maxDepth: 3, maxConcurrentDescendants: 5, maxLaunchesPerLineage: 20 },
    herdrViewer: { enabled: false },
  });
  assert.deepEqual(loadStatusConfig(undefined, undefined, env), { enabled: false, lineLimit: 4 });
  assert.throws(
    () => loadRuntimeConfig(undefined, undefined, { PI_SUBAGENTS_CONFIG: "relative.json" }),
    /must be an absolute path/i,
  );
  assert.throws(
    () => loadRuntimeConfig(undefined, undefined, { PI_SUBAGENTS_CONFIG: join(dir, "missing.json") }),
    /Cannot read PI_SUBAGENTS_CONFIG/i,
  );
});
