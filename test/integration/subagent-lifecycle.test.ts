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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStatusState } from "../../pi-extension/subagents/status.ts";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import { registerName } from "../../pi-extension/subagents/session.ts";
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
  waitForPaneOutput,
  type TestEnv,
} from "./harness.ts";
import {
  closeHerdrPane,
  getHerdrAgent,
  listHerdrPanes,
  readHerdrPane,
  type HerdrAgentState,
} from "../../pi-extension/subagents/herdr.ts";
import {
  quoteArg,
  resolveShellSpec,
} from "../../pi-extension/subagents/shell.ts";

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

  it("degrades to text + enter when the pane never hosts a ready agent", async () => {
    // A bare shell pane never reports an agent state, so the readiness gate
    // expires and the one degraded transport delivers the pending task.
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    const unique = uniqueId();
    const spec = resolveShellSpec();
    const left = "degraded-";
    const right = `probe-${unique}`;
    // Both families print the two halves joined; the typed command text only
    // ever contains them separately.
    running.pendingTask =
      spec.kind === "powershell"
        ? `Write-Output (${quoteArg(spec.kind, left)} + ${quoteArg(spec.kind, right)})`
        : `printf '%s%s\\n' ${quoteArg(spec.kind, left)} ${quoteArg(spec.kind, right)}`;
    const controller = new AbortController();
    const watching = testApi.watchSubagent(running, controller.signal);

    try {
      // The joined marker exists only in the command's OUTPUT — the typed
      // command text contains the two halves separately, so a single
      // occurrence proves the task was delivered exactly once.
      const marker = `degraded-probe-${unique}`;
      await waitForPaneOutput(paneId, marker, 60_000);
      assert.equal(
        running.deliveryMode,
        "degraded",
        "the gate expiry must be reported as degraded delivery",
      );
      const text = await readHerdrPane(paneId, 100);
      const occurrences = text.split(marker).length - 1;
      assert.equal(
        occurrences,
        1,
        `the task must be delivered exactly once, saw ${occurrences}`,
      );
    } finally {
      controller.abort();
      await watching.catch(() => {
        /* the run is cancelled deliberately */
      });
    }
  });

  it("reports a steer to a pane with no agent instead of typing into it", async () => {
    const paneId = await createTrackedPane(env);
    const running = makeRunning(env, paneId);
    const marker = `steer-${uniqueId()}`;

    const result = await testApi.steerSubagent(running, `echo ${marker}`);

    assert.ok("error" in result, "the failure is reported, not assumed sent");
    assert.match(result.error, /Failed to deliver message/);
    await sleep(300);
    const text = await readHerdrPane(paneId, 50);
    assert.ok(
      !text.includes(marker),
      "a failed agent-layer steer must not be typed into the pane",
    );
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

// ── Model-backed lifecycle helpers ──

/**
 * User turns recorded in a child's session transcript, one string per turn.
 * A turn is one JSONL message entry with `role: "user"`; the text blocks of
 * that entry are concatenated so multi-line submissions stay one turn.
 */
function readUserTurns(sessionFile: string): string[] {
  if (!existsSync(sessionFile)) return [];
  const turns: string[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry?.message?.role !== "user") continue;
    const text = (entry.message.content ?? [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text ?? "")
      .join("");
    if (text) turns.push(text);
  }
  return turns;
}

/** Poll Herdr's agent state until it reports one of the wanted states. */
async function waitForAgentState(
  paneId: string,
  wanted: HerdrAgentState[],
  timeout = 90_000,
): Promise<HerdrAgentState> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await getHerdrAgent(paneId).catch(
      () => "unknown" as HerdrAgentState,
    );
    if (wanted.includes(state)) return state;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout (${timeout}ms) waiting for agent state ${wanted.join("/")} in ${paneId}; last state ${state}`,
      );
    }
    await sleep(500);
  }
}

/** Wait until a pane no longer appears in Herdr's pane list. */
async function waitForPaneGone(
  paneId: string,
  timeout = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const panes = (await listHerdrPanes()).map((pane) => pane.pane_id);
    if (!panes.includes(paneId)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout (${timeout}ms) waiting for pane ${paneId} to close`,
      );
    }
    await sleep(250);
  }
}

/** Minimal ExtensionAPI double: captures registered tools and sent messages. */
function createMockPi() {
  const tools: Array<any> = [];
  const sentMessages: Array<any> = [];
  const api = {
    on() {},
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage(message: any, options?: any) {
      sentMessages.push({ message, options });
    },
    getAllTools() {
      return [];
    },
  } as any;
  return { api, tools, sentMessages };
}

/** Wait for a captured pi message matching the predicate. */
async function waitForMockMessage(
  messages: Array<any>,
  predicate: (entry: any) => boolean,
  timeout = 120_000,
): Promise<any> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const match = messages.find(predicate);
    if (match) return match;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout (${timeout}ms) waiting for an expected orchestrator message; ` +
          `saw: ${messages.map((m) => m.message?.customType ?? "?").join(", ") || "none"}`,
      );
    }
    await sleep(500);
  }
}

function makeOrchestratorCtx(env: TestEnv, sessionId: string) {
  const sessionDir = join(env.dir, `orchestrator-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  const parentSessionFile = join(sessionDir, "parent.jsonl");
  writeFileSync(
    parentSessionFile,
    `${JSON.stringify({ type: "session", id: sessionId })}\n`,
    "utf8",
  );
  return {
    sessionDir,
    parentSessionFile,
    ctx: {
      sessionManager: {
        getSessionFile: () => parentSessionFile,
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
      cwd: env.dir,
    } as any,
  };
}

/** Run a callback with the process cwd set to the test project directory. */
async function withTestCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe("subagent lifecycle — model-backed steering, questions, and resume", {
  skip: modelReady ? false : MODEL_SKIP,
}, () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv("pi-lifecycle-model");
  });

  after(async () => {
    (subagentsModule as any).__test__.stopRefreshTimers?.();
    await cleanupTestEnv(env);
  });

  it("delivers a multi-line steer to a running pi child as one turn", async () => {
    const testApi = (subagentsModule as any).__test__;
    const paneId = await createTrackedPane(env);
    const childSession = join(env.dir, `steer-session-${uniqueId()}.jsonl`);
    await startPiInPane(env, paneId, "", { sessionFile: childSession });

    const running = makeRunning(env, paneId);
    running.pendingTask =
      "Integration steer probe: reply with the single word FIRST.";
    const controller = new AbortController();
    const watching = testApi.watchSubagent(running, controller.signal);

    try {
      // Wait for the first turn to land and the child to settle before steering.
      await waitForFile(childSession, 120_000, /Integration steer probe/);
      await waitForAgentState(paneId, ["idle", "done"]);

      const steerText = "Steer probe line one.\nSteer probe line two.";
      const steer = await testApi.steerSubagent(running, steerText);
      assert.deepEqual(steer, { ok: true });

      await waitForFile(childSession, 120_000, /Steer probe line two/);
      const turns = readUserTurns(childSession).filter((turn) =>
        turn.includes("Steer probe line one"),
      );
      assert.equal(
        turns.length,
        1,
        "the steer must arrive as exactly one user turn",
      );
      assert.match(
        turns[0],
        /Steer probe line one\.\nSteer probe line two\./,
        "both lines must arrive as one turn with the line break preserved",
      );
    } finally {
      controller.abort();
      await watching.catch(() => {
        /* the run is cancelled deliberately */
      });
    }
  });

  it("round-trips a subagent question and resumes the run with the reply", async () => {
    const testApi = (subagentsModule as any).__test__;
    const mock = createMockPi();
    (subagentsModule as any).default(mock.api);
    const { ctx } = makeOrchestratorCtx(env, "question-parent");
    const name = `Pinger-${uniqueId()}`;

    const spawnTool = mock.tools.find((tool) => tool.name === "subagent");
    const spawned = await withTestCwd(env.dir, () =>
      spawnTool.execute(
        "q-spawn",
        { agent: "test-ping", task: "What is the secret word?", name },
        undefined,
        undefined,
        ctx,
      ),
    );
    assert.equal(spawned.details.error, undefined, spawned.details.error);
    const running = (testApi.runningSubagents as Map<string, any>).get(
      spawned.details.id,
    );
    assert.ok(running, "the spawned child is tracked while running");

    // The child asks its question; the watcher notifies the orchestrator once.
    const question = await waitForMockMessage(
      mock.sentMessages,
      (entry) => entry.message?.customType === "subagent_question",
    );
    assert.match(question.message.content, /What is the secret word\?/);
    assert.equal(question.options?.deliverAs, "steer");
    assert.equal(
      existsSync(`${running.sessionFile}.ask`),
      false,
      "the ask sidecar is consumed after delivery",
    );
    const panes = (await listHerdrPanes()).map((pane) => pane.pane_id);
    assert.ok(
      panes.includes(running.paneId),
      "the pane stays open while the question is pending",
    );
    assert.equal(
      (testApi.runningSubagents as Map<string, any>).has(running.id),
      true,
      "the session stays parked for the reply",
    );

    // The reply lands as the child's next turn and the child finishes cleanly.
    const reply = await testApi.steerSubagent(running, "BLUE");
    assert.deepEqual(reply, { ok: true });
    await waitForFile(running.sessionFile, 120_000, /PONG: BLUE/);
    assert.ok(
      readUserTurns(running.sessionFile).some((turn) => turn.includes("BLUE")),
      "the reply is recorded as the child's next user turn",
    );

    const result = await waitForMockMessage(
      mock.sentMessages,
      (entry) =>
        entry.message?.customType === "subagent_result" &&
        entry.message?.details?.name === name,
    );
    assert.equal(result.message.details.exitCode, 0);
    await waitForPaneGone(running.paneId);
  });

  it("resumes a finished subagent by name in a fresh pane with its session and sandbox", async () => {
    const testApi = (subagentsModule as any).__test__;
    const mock = createMockPi();
    (subagentsModule as any).default(mock.api);
    const { ctx } = makeOrchestratorCtx(env, "resume-parent");
    const name = `Resumer-${uniqueId()}`;

    const spawnTool = mock.tools.find((tool) => tool.name === "subagent");
    const messageTool = mock.tools.find(
      (tool) => tool.name === "subagent_message",
    );

    // Spawn the original run and let it finish on its own (auto-exit agent).
    const spawned = await withTestCwd(env.dir, () =>
      spawnTool.execute(
        "r-spawn",
        {
          agent: "test-echo",
          task: "Write the word ALPHA to alpha.txt, then stop.",
          name,
        },
        undefined,
        undefined,
        ctx,
      ),
    );
    assert.equal(spawned.details.error, undefined, spawned.details.error);
    const sessionFile = spawned.details.sessionFile;
    const firstRun = (testApi.runningSubagents as Map<string, any>).get(
      spawned.details.id,
    );
    assert.ok(firstRun);
    const firstPane = firstRun.paneId;

    await waitForMockMessage(
      mock.sentMessages,
      (entry) =>
        entry.message?.customType === "subagent_result" &&
        entry.message?.details?.name === name,
    );
    assert.equal(
      existsSync(`${sessionFile}.loadout.json`),
      true,
      "spawn persisted the sandbox snapshot beside the session",
    );
    await waitForPaneGone(firstPane);

    // Resume through the real tool: same name, same session, fresh pane.
    const resumed = await withTestCwd(env.dir, () =>
      messageTool.execute(
        "r-resume",
        {
          name,
          message:
            "Now write the word BETA to beta.txt and reply with RESUME-OK.",
        },
        undefined,
        undefined,
        ctx,
      ),
    );
    assert.equal(resumed.details.status, "started");
    assert.equal(resumed.details.name, name, "the run reclaims its name");
    assert.equal(
      resumed.details.sessionFile,
      sessionFile,
      "the prior session is replayed",
    );
    const resumedRun = (testApi.runningSubagents as Map<string, any>).get(
      resumed.details.id,
    );
    assert.ok(resumedRun, "the resumed run is tracked");
    assert.notEqual(resumedRun.paneId, firstPane, "a fresh pane hosts the run");

    // The launch script replays the sandbox from the snapshot.
    const script = readFileSync(resumed.details.launchScriptFile, "utf8");
    assert.ok(
      script.includes(sessionFile),
      "the resumed launch script starts the prior session",
    );
    assert.ok(
      script.includes("--no-extensions"),
      "the replayed sandbox keeps the default-deny extension restriction",
    );

    // The message arrives as the child's next turn.
    try {
      await waitForFile(sessionFile, 120_000, /RESUME-OK/);
      assert.ok(
        readUserTurns(sessionFile).some((turn) =>
          turn.includes("write the word BETA"),
        ),
        "the resume message is recorded as a user turn",
      );
    } finally {
      resumedRun.abortController?.abort();
      await waitForPaneGone(resumedRun.paneId).catch(() => {
        /* cleanup must not mask an assertion failure */
      });
    }
  });

  it("refuses to resume when the sandbox snapshot is missing", async () => {
    const mock = createMockPi();
    (subagentsModule as any).default(mock.api);
    const { sessionDir, ctx } = makeOrchestratorCtx(env, "legacy-parent");

    // A registry entry whose session predates the sandbox snapshot.
    const childSession = join(env.dir, `legacy-${uniqueId()}.jsonl`);
    writeFileSync(
      childSession,
      `${JSON.stringify({ type: "session", id: "legacy-child" })}\n`,
      "utf8",
    );
    registerName(join(sessionDir, "artifacts", "legacy-parent"), "Legacy", {
      sessionFile: childSession,
      sessionId: "legacy-child",
    });

    const messageTool = mock.tools.find(
      (tool) => tool.name === "subagent_message",
    );
    const result = await messageTool.execute(
      "legacy-resume",
      { name: "Legacy", message: "hi" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.details.error, /Cannot safely resume "Legacy"/);
    assert.match(result.details.error, /loadout|predates sandboxed resume/);
  });
});
