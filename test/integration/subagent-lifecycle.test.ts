/**
 * Lifecycle tests for subagent orchestration (spec `subagent-orchestration`,
 * design D4/D11).
 *
 * The first suite drives the orchestration watcher against real Herdr panes
 * with scripted children, so completion, sidecar, cleanup, and persistence
 * behavior stay verifiable without a model provider. The second suite covers
 * the readiness-gate/delivery path with a real pi child and is skipped unless
 * the configured test model's provider is authenticated.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStatusState } from "../../pi-extension/subagents/status.ts";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import {
  SKIP_REASON,
  assertFocusUnchanged,
  cleanupTestEnv,
  createTestEnv,
  createTrackedPane,
  getAvailableBackends,
  getFocusedPane,
  runInPane,
  sleep,
  startPiInPane,
  uniqueId,
  waitForFile,
  type TestEnv,
} from "./harness.ts";
import {
  closeHerdrPane,
  listHerdrPanes,
} from "../../pi-extension/subagents/herdr.ts";

const available = getAvailableBackends().length > 0;
const testApi = (subagentsModule as any).__test__ as any;

const TEST_MODEL = process.env.PI_TEST_MODEL ?? "deepseek/deepseek-flash";

/**
 * True when the configured test model's provider is authenticated.
 *
 * `shell: true` is required on Windows: `pi` is a `.cmd` shim and Node cannot
 * spawn it directly (ENOENT). The node directory is tried as a fallback so the
 * probe also works when a runner does not expose the shim on PATH. The model
 * string is guarded against shell metacharacters before it reaches the shell.
 */
function providerReady(): boolean {
  if (!/^[A-Za-z0-9._/:-]+$/.test(TEST_MODEL)) return false;
  const candidates = [
    "pi",
    join(
      dirname(process.execPath),
      process.platform === "win32" ? "pi.cmd" : "pi",
    ),
  ];
  for (const executable of candidates) {
    try {
      execFileSync(executable, ["auth", "check", "--model", TEST_MODEL], {
        stdio: "ignore",
        shell: true,
      });
      return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

const modelReady = available && providerReady();
const MODEL_SKIP =
  `no authenticated provider for ${TEST_MODEL} — set PI_TEST_MODEL to a model ` +
  `whose provider is logged in to enable model-backed lifecycle tests`;

function makeRunning(env: TestEnv, paneId: string) {
  const id = uniqueId();
  const sessionFile = join(env.dir, `child-${id}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", id: `sess-${id}` })}\n`,
    "utf8",
  );
  return {
    id,
    name: `Child-${id}`,
    task: "scripted task",
    paneId,
    startTime: Date.now(),
    sessionFile,
    interactive: false,
    pendingTask: undefined as string | undefined,
    deliveryMode: undefined as "agent" | "degraded" | undefined,
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
  };
}

describe("subagent lifecycle — scripted children", {
  skip: available ? false : SKIP_REASON,
}, () => {
  let env: TestEnv;
  let focusBefore: string | null = null;

  before(async () => {
    env = await createTestEnv("pi-lifecycle");
    focusBefore = await getFocusedPane();
  });

  after(async () => {
    await cleanupTestEnv(env);
  });

  it("detects a clean completion, closes the pane, and retains the launch artifact", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    const map = testApi.runningSubagents as Map<string, unknown>;
    map.set(running.id, running);

    const scriptPath = await runInPane(env, paneId, "exit 0");
    const result = await testApi.watchSubagent(
      running,
      new AbortController().signal,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(map.has(running.id), false, "the running entry is removed");
    assert.equal(
      existsSync(scriptPath),
      true,
      "the launch script is retained for debugging",
    );
    const panes = (await listHerdrPanes()).map((pane) => pane.pane_id);
    assert.ok(!panes.includes(paneId), "the pane is closed after completion");
  });

  it("decodes a non-zero exit code", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    (testApi.runningSubagents as Map<string, unknown>).set(running.id, running);
    await runInPane(env, paneId, "exit 7");
    const result = await testApi.watchSubagent(
      running,
      new AbortController().signal,
    );
    assert.equal(result.exitCode, 7);
  });

  it("lets the error sidecar win over the sentinel and consumes it", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    (testApi.runningSubagents as Map<string, unknown>).set(running.id, running);
    await runInPane(env, paneId, "exit 0");
    const sidecar = `${running.sessionFile}.exit`;
    writeFileSync(
      sidecar,
      JSON.stringify({
        type: "error",
        errorMessage: "Anthropic 529 overloaded after 3 retries",
      }),
      "utf8",
    );

    const result = await testApi.watchSubagent(
      running,
      new AbortController().signal,
    );

    assert.equal(result.exitCode, 1);
    assert.equal(
      result.errorMessage,
      "Anthropic 529 overloaded after 3 retries",
    );
    assert.equal(existsSync(sidecar), false, "the sidecar is consumed");
  });

  it("terminates a run whose pane disappears", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    const map = testApi.runningSubagents as Map<string, unknown>;
    map.set(running.id, running);

    const watching = testApi.watchSubagent(
      running,
      new AbortController().signal,
    );
    await sleep(400);
    await closeHerdrPane(paneId);

    const result = await watching;
    assert.match(
      String(result.error),
      /disappeared before completion/,
      "the run reports the missing pane",
    );
    assert.equal(map.has(running.id), false, "the running entry is removed");
  });

  it("honours a late sidecar when the pane disappears", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    (testApi.runningSubagents as Map<string, unknown>).set(running.id, running);

    const watching = testApi.watchSubagent(
      running,
      new AbortController().signal,
    );
    await sleep(400);
    writeFileSync(
      `${running.sessionFile}.exit`,
      JSON.stringify({ type: "error", errorMessage: "late sidecar" }),
      "utf8",
    );
    await closeHerdrPane(paneId);

    const result = await watching;
    assert.equal(result.errorMessage, "late sidecar");
  });

  it("cancels a run: the pane is closed and the entry removed", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    const map = testApi.runningSubagents as Map<string, unknown>;
    map.set(running.id, running);

    const controller = new AbortController();
    const watching = testApi.watchSubagent(running, controller.signal);
    await sleep(300);
    controller.abort();

    const result = await watching;
    assert.equal(result.error, "cancelled");
    assert.equal(map.has(running.id), false);
    const panes = (await listHerdrPanes()).map((pane) => pane.pane_id);
    assert.ok(!panes.includes(paneId), "cancellation closes the pane");
  });

  it("spawns a child: pane created, focus unchanged, child process starts", async () => {
    const sessionDir = join(env.dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const parentSessionFile = join(sessionDir, "parent.jsonl");
    writeFileSync(
      parentSessionFile,
      `${JSON.stringify({ type: "session", id: "parent-1" })}\n`,
      "utf8",
    );
    const ctx = {
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => "parent-1",
        getSessionDir: () => sessionDir,
      },
      cwd: env.dir,
    };

    const running = await testApi.launchSubagent(
      { agent: "worker", task: "say nothing", name: `Spawn-${uniqueId()}` },
      ctx,
    );

    try {
      assert.ok(running.paneId.includes(":"), "a real pane hosts the child");
      assert.equal(typeof running.launchScriptFile, "string");
      assert.equal(
        existsSync(running.launchScriptFile),
        true,
        "the launch script is written to the session artifacts",
      );
      await assertFocusUnchanged(focusBefore, "after spawn");

      // The child process comes up and is recognized as a pi agent.
      let childUp = false;
      for (let attempt = 0; attempt < 40 && !childUp; attempt += 1) {
        const pane = (await listHerdrPanes()).find(
          (candidate) => candidate.pane_id === running.paneId,
        );
        childUp = pane?.agent === "pi";
        if (!childUp) await sleep(500);
      }
      assert.equal(
        childUp,
        true,
        "the spawned pi child is detected in its pane",
      );
    } finally {
      (testApi.runningSubagents as Map<string, unknown>).delete(running.id);
      await closeHerdrPane(running.paneId).catch(() => {
        /* the pane may already be gone */
      });
    }
  });

  it("keeps the user's focus unchanged throughout", async () => {
    await assertFocusUnchanged(focusBefore, "after lifecycle runs");
  });
});

describe("subagent lifecycle — model-backed readiness gate", {
  skip: modelReady ? false : MODEL_SKIP,
}, () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv("pi-lifecycle-model");
  });

  after(async () => {
    await cleanupTestEnv(env);
  });

  it("delivers the composed task to a real pi child once it reports ready", async () => {
    const paneId = await createTrackedPane(env);
    const childSession = join(env.dir, `child-session-${uniqueId()}.jsonl`);
    // Launch a bare child with its own session file: no task argv, so the
    // gate's delivery is its first user turn.
    await startPiInPane(env, paneId, "", { sessionFile: childSession });

    const running = makeRunning(env, paneId);
    running.pendingTask =
      "Integration gate probe: reply with the single word READY.";
    const controller = new AbortController();
    const watching = testApi.watchSubagent(running, controller.signal);

    // The child's own transcript is the delivery oracle. The pane's plain
    // text buffer is not reliable for a TUI child — it redraws and scrolls,
    // so an early assertion there would race the child's rendering.
    const transcript = await waitForFile(
      childSession,
      120_000,
      /Integration gate probe/,
    );
    assert.match(transcript, /Integration gate probe/);
    assert.equal(
      running.deliveryMode,
      "agent",
      "the task must go through the agent layer, not the degraded transport",
    );

    controller.abort();
    await watching.catch(() => {
      /* the run is cancelled deliberately */
    });
  });
});
