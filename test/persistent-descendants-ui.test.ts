import test from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../pi-extension/subagents/index.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import { parseRuntimeConfig } from "../pi-extension/subagents/runtime-config.ts";

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
});

test("runtime config defaults and validates shared lineage limits", () => {
  assert.deepEqual(parseRuntimeConfig({ status: { enabled: true } }), {
    delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: 12 },
    herdrViewer: { enabled: true },
  });
  assert.throws(
    () => parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: -1 } }),
    /maxLaunchesPerLineage/,
  );
  assert.throws(
    () => parseRuntimeConfig({ delegation: { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: 12, dollars: 1 } }),
    /unsupported key.*dollars/,
  );
});
