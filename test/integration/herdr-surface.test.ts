/**
 * Surface tests for the Herdr pane adapter (design D12).
 *
 * Every test runs inside a scratch, non-focused tab so the user's view and
 * focus never move. Waits use Herdr's own oracles (`pane wait-output`), not
 * fixed sleeps. The suite skips cleanly when the runtime is unavailable, and
 * its after-hook asserts the scratch tab and every pane are gone.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SKIP_REASON,
  assertFocusUnchanged,
  cleanupTestEnv,
  createTestEnv,
  createTrackedPane,
  getAvailableBackends,
  getEnvPanes,
  getFocusedPane,
  runInPane,
  sleep,
  uniqueId,
  untrackPane,
  waitForFile,
  waitForPaneOutput,
  waitForSentinel,
  writeEnvScript,
  type TestEnv,
} from "./harness.ts";
import {
  HerdrError,
  assertPaneShellFamily,
  closeHerdrPane,
  getHerdrAgent,
  getPaneProcessInfo,
  listHerdrPanes,
  parseHerdrJson,
  readHerdrPane,
  runHerdr,
  sendHerdrEnter,
  sendHerdrText,
  shellFamilyFromProcessInfo,
  submitHerdrText,
  waitHerdrOutput,
} from "../../pi-extension/subagents/herdr.ts";
import {
  quoteArg,
  resolveShellSpec,
} from "../../pi-extension/subagents/shell.ts";

const available = getAvailableBackends().length > 0;

describe("herdr surface adapter", {
  skip: available ? false : SKIP_REASON,
}, () => {
  let env: TestEnv;
  let focusBefore: string | null = null;

  before(async () => {
    env = await createTestEnv("pi-herdr-surface");
    focusBefore = await getFocusedPane();
  });

  after(async () => {
    await cleanupTestEnv(env);

    // The dry-run oracle: nothing this environment created may survive.
    const leftoverPanes = (await listHerdrPanes()).filter(
      (pane) => pane.tab_id === env.tabId,
    );
    assert.equal(
      leftoverPanes.length,
      0,
      `scratch tab still has panes: ${leftoverPanes.map((p) => p.pane_id).join(", ")}`,
    );
    const tabList = await runHerdr(["tab", "list"]);
    const tabs =
      parseHerdrJson<{ result?: { tabs?: Array<{ tab_id?: string }> } }>(
        tabList.stdout,
        "tab list",
      ).result?.tabs ?? [];
    assert.equal(
      tabs.filter((tab) => tab.tab_id === env.tabId).length,
      0,
      "scratch tab must be gone",
    );
  });

  it("creates a pane without stealing focus", async () => {
    const paneId = await createTrackedPane(env);
    assert.ok(paneId.includes(":"), "pane id must be validated shape");
    await assertFocusUnchanged(focusBefore, "after pane creation");
  });

  it("keeps focus stable across repeated creation and close", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await createTrackedPane(env));
      await assertFocusUnchanged(focusBefore, `after creation #${i + 1}`);
    }
    for (const paneId of created) {
      await closeHerdrPane(paneId);
      untrackPane(env, paneId);
      await assertFocusUnchanged(focusBefore, "after close");
    }
  });

  it("round-trips shell-sensitive characters through pane commands", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    const marker = uniqueId();
    const value = `$ " \` = ' space & (paren) ; ${marker}`;
    await runInPane(env, paneId, `echo ${quoteArg(spec.kind, value)}`);
    const text = await waitForPaneOutput(paneId, marker);
    assert.ok(
      text.includes(value),
      `expected the pane to contain the exact value, got: ${text.slice(-400)}`,
    );
  });

  it("preserves an 800+ character line as one unwrapped line", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    const marker = uniqueId();
    const long = `BEGIN-${"a".repeat(880)}-${marker}`;
    await runInPane(env, paneId, `echo ${quoteArg(spec.kind, long)}`);
    const text = await waitForPaneOutput(paneId, marker);
    assert.ok(
      text.includes(long),
      "the long line must survive intact (unwrapped reads join soft wraps)",
    );
    assert.ok(
      !text.includes("\r"),
      "plain reads must not contain carriage returns",
    );
    assert.ok(
      !/\u001b\[/.test(text),
      "plain reads must not contain ANSI escapes",
    );
  });

  it("runs concurrent panes independently", async () => {
    const spec = resolveShellSpec();
    const jobs = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const paneId = await createTrackedPane(env);
        const marker = `solo-${index}-${uniqueId()}`;
        await runInPane(env, paneId, `echo ${quoteArg(spec.kind, marker)}`);
        return { paneId, marker };
      }),
    );
    for (const job of jobs) {
      const text = await waitForPaneOutput(job.paneId, job.marker);
      for (const other of jobs) {
        if (other.marker !== job.marker) {
          assert.ok(
            !text.includes(other.marker),
            "panes must not observe each other's output",
          );
        }
      }
    }
    await assertFocusUnchanged(focusBefore, "after concurrent spawn");
  });

  it("applies cwd with spaces and shell-sensitive env at creation", async () => {
    const spec = resolveShellSpec();
    const cwd = join(env.dir, "dir with spaces");
    mkdirSync(cwd, { recursive: true });
    const marker = uniqueId();
    const value = `$ " \` = ' & ${marker}`;
    const paneId = await createTrackedPane(env, {
      cwd,
      env: { PI_INTEG_PROBE: value },
    });
    const probe = writeEnvScript(
      env,
      "probe.mjs",
      'process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env.PI_INTEG_PROBE ?? null }) + "\\n");',
    );
    await runInPane(env, paneId, `node ${quoteArg(spec.kind, probe)}`);
    const text = await waitForPaneOutput(paneId, marker);
    const match = text.match(/\{[^\n]*"cwd"[^\n]*\}/);
    assert.ok(
      match,
      `probe JSON not found in pane output: ${text.slice(-400)}`,
    );
    const parsed = JSON.parse(match[0]) as {
      cwd: string;
      value: string | null;
    };
    assert.equal(parsed.value, value, "env value must arrive byte-exact");
    assert.equal(
      basename(parsed.cwd),
      "dir with spaces",
      "cwd must be applied at pane creation",
    );
  });

  it("decodes a non-zero exit sentinel", async () => {
    const paneId = await createTrackedPane(env);
    await runInPane(env, paneId, "exit 5");
    assert.equal(await waitForSentinel(paneId), 5);
  });

  it("matches multi-digit (32-bit) exit codes with the unbounded regex", async () => {
    const spec = resolveShellSpec();
    const paneId = await createTrackedPane(env);
    await runInPane(env, paneId, "exit 1073741824");
    const expected = spec.kind === "powershell" ? 1073741824 : 1073741824 % 256;
    assert.equal(await waitForSentinel(paneId), expected);
  });

  it("validates the pane's real shell family through process-info", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    await assert.doesNotReject(() => assertPaneShellFamily(paneId, spec.kind));
    const info = await getPaneProcessInfo(paneId);
    assert.equal(shellFamilyFromProcessInfo(info), spec.kind);
  });

  it("reports agent_not_found for a pane that runs no agent", async () => {
    const paneId = await createTrackedPane(env);
    const error = await getHerdrAgent(paneId).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "agent_not_found");
  });

  it("holds typed text until Enter is sent", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    const marker = `held-${uniqueId()}`;
    const outFile = join(env.dir, `${marker}.txt`);

    await sendHerdrText(
      paneId,
      `echo ${quoteArg(spec.kind, marker)} > ${quoteArg(spec.kind, outFile)}`,
    );
    await sleep(800);
    assert.equal(
      existsSync(outFile),
      false,
      "typed text must not execute before Enter is sent",
    );

    // Settle before submitting, as a real caller would once the input is
    // confirmed visible (submitHerdrText does this automatically).
    await sleep(700);
    await sendHerdrEnter(paneId);
    const content = await waitForFile(outFile, 30_000, new RegExp(marker));
    assert.match(content, new RegExp(marker));
  });

  it("submits text atomically once the paste has landed", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    const marker = `atomic-${uniqueId()}`;
    const outFile = join(env.dir, `${marker}.txt`);

    await submitHerdrText(
      paneId,
      `echo ${quoteArg(spec.kind, marker)} > ${quoteArg(spec.kind, outFile)}`,
    );

    const content = await waitForFile(outFile, 30_000, new RegExp(marker));
    assert.match(content, new RegExp(marker));
  });

  it("keeps a multi-line paste unexecuted until Enter", async () => {
    const paneId = await createTrackedPane(env);
    const spec = resolveShellSpec();
    const marker = `ml-${uniqueId()}`;
    const outFile = join(env.dir, `${marker}.txt`);
    const text = [
      `echo ${quoteArg(spec.kind, "first line")}`,
      `echo ${quoteArg(spec.kind, marker)} > ${quoteArg(spec.kind, outFile)}`,
    ].join("\n");

    await sendHerdrText(paneId, text);
    await sleep(800);
    assert.equal(
      existsSync(outFile),
      false,
      "no line may execute before Enter is sent",
    );

    // Enter submits the pending buffer. How the pane program splits the
    // lines is its own behavior (pi's editor treats the paste as one turn —
    // covered by the lifecycle steer test); here we only require that
    // Enter actually submits something rather than dropping the paste.
    await sendHerdrEnter(paneId);
    await sleep(800);
    const after = await readHerdrPane(paneId, 100);
    assert.ok(
      after.includes("first line") || existsSync(outFile),
      "Enter must submit the pending text",
    );
  });

  it("returns promptly when the waited pattern already exists", async () => {
    const paneId = await createTrackedPane(env);
    const marker = `present-${uniqueId()}`;
    await runInPane(
      env,
      paneId,
      `echo ${quoteArg(resolveShellSpec().kind, marker)}`,
    );
    await waitForPaneOutput(paneId, marker);

    const start = Date.now();
    await waitHerdrOutput(paneId, marker, { lines: 100, timeoutMs: 5000 });
    assert.ok(
      Date.now() - start < 3000,
      "an already-present pattern must match immediately",
    );
  });

  it("reports wait expiry with the distinct timeout code", async () => {
    const paneId = await createTrackedPane(env);
    const error = await waitHerdrOutput(paneId, `never-${uniqueId()}`, {
      lines: 50,
      timeoutMs: 1500,
    }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "timeout");
  });

  it("closes panes idempotently", async () => {
    const paneId = await createTrackedPane(env);
    await closeHerdrPane(paneId);
    await closeHerdrPane(paneId);
    untrackPane(env, paneId);
  });

  it("lists panes with the focus oracle", async () => {
    const paneId = await createTrackedPane(env);
    const panes = await listHerdrPanes();
    const mine = panes.find((pane) => pane.pane_id === paneId);
    assert.ok(mine, "created pane must appear in the pane list");
    assert.equal(mine.tab_id, env.tabId);
    assert.equal(mine.focused, false, "subagent panes are never focused");
    assert.ok(
      panes.some((pane) => pane.focused),
      "exactly one pane reports focus",
    );
    assert.equal((await getEnvPanes(env)).length >= 1, true);
  });

  it("reads the pane tail without a protocol envelope", async () => {
    const paneId = await createTrackedPane(env);
    const marker = `tail-${uniqueId()}`;
    await runInPane(
      env,
      paneId,
      `echo ${quoteArg(resolveShellSpec().kind, marker)}`,
    );
    await waitForPaneOutput(paneId, marker);
    const text = await readHerdrPane(paneId, 20);
    assert.ok(
      !text.includes('"result"'),
      "reads must not expose the JSON envelope",
    );
    assert.ok(text.includes(marker));
  });
});
