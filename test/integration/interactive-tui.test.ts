import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createSurface, sendLongCommand, sendCommand, closeSurface, shellEscape, pollForExit, waitSurfaceReady } from "../../pi-extension/subagents/surface.ts";

const cli = process.env.PI_TEST_CLI;
async function until(check: () => boolean) {
  const end = Date.now() + 15000;
  while (!check()) { assert.ok(Date.now() < end, "deadline exceeded"); await delay(25); }
}
test("official Pi TUI: isolated faux provider, IPC kickoff/steering/answer and settled shutdown", { skip: !cli, timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tui-e2e-"));
  const surface = createSurface("tui-e2e", { surfaceBackend: "process" });
  const session = join(root, "session.jsonl");
  const file = (name: string) => join(root, name);
  mkdirSync(file("home")); mkdirSync(file("agent"));
  const env = {
    HOME: file("home"), PI_CODING_AGENT_DIR: file("agent"), PATH: dirname(process.execPath) + ":/usr/bin:/bin", TERM: "xterm-256color", PI_OFFLINE: "1",
    PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_SESSION: session,
    PI_TEST_FAUX: resolve(dirname(cli!), "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js"),
    PI_TEST_MODE: file("mode"), PI_TEST_STARTED: file("started"), PI_TEST_DANGER: file("danger"), PI_TEST_INPUTS: file("inputs"), PI_TEST_SETTLED: file("settled"),
  };
  try {
    const command = `cd ${shellEscape(root)} && env -i PI_SUBAGENT_IPC_DIR="$PI_SUBAGENT_IPC_DIR" ${Object.entries(env).map(([k,v]) => `${k}=${shellEscape(v)}`).join(" ")} ${[process.execPath, cli!, "--session", session, "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--tools", "ask_question", "-e", resolve("pi-extension/subagents/subagent-done.ts"), "-e", resolve("test/integration/fixtures/faux-interactive.ts"), "--model", "interactive-faux/local"].map(shellEscape).join(" ")}`;
    sendLongCommand(surface, command, { scriptPath: file("launch.sh"), interactive: { messages: [{ message: "KICKOFF\nsecond line", deliverAs: "followUp" }] } });
    await waitSurfaceReady(surface, { sessionFile: session });
    await until(() => existsSync(file("started")));
    assert.deepEqual(JSON.parse(readFileSync(file("mode"), "utf8")), { mode: "tui", stdin: true, stdout: true });
    await sendCommand(surface, "/danger\nSTEER\n  preserved");
    await until(() => existsSync(file("settled")));
    assert.ok(existsSync(`${session}.ask`), "question is published before shutdown");
    assert.ok(!existsSync(file("danger")), "steering must not execute slash command");
    await sendCommand(surface, "ANSWER\ncontract accepted");
    const exit = await pollForExit(surface, new AbortController().signal, { interval: 25 });
    assert.equal(exit.exitCode, 0);
    const inputs = readFileSync(file("inputs"), "utf8").trim().split("\n").map(line => JSON.parse(line).text);
    assert.deepEqual(inputs, ["KICKOFF\nsecond line", "/danger\nSTEER\n  preserved", "ANSWER\ncontract accepted"]);
    assert.match(readFileSync(session, "utf8"), /FINAL_CONTEXT/);
    assert.equal(readFileSync(file("settled"), "utf8").trim().split("\n").length, 2);
    const absent = createSurface("missing-reader", { surfaceBackend: "process" });
    try {
      const noReader = command.replace(`${shellEscape("-e")} ${shellEscape(resolve("pi-extension/subagents/subagent-done.ts"))} `, "");
      sendLongCommand(absent, noReader, { scriptPath: file("missing.sh"), interactive: { messages: [] } });
      await assert.rejects(waitSurfaceReady(absent, { timeoutMs: 1500 }), /ready.*timed out/i);
    } finally { closeSurface(absent); }
    writeFileSync(file("inputs"), "");
    const lifecycle = spawnSync(process.execPath, [resolve("test/integration/fixtures/interactive-launch-resume.ts")], {
      env: { ...env, PI_TEST_CLI: cli! }, encoding: "utf8", timeout: 35000,
    });
    assert.equal(lifecycle.status, 0, `${lifecycle.error ?? ""}\n${lifecycle.stdout}\n${lifecycle.stderr}`);
    const policy = spawnSync(process.execPath, [resolve("test/integration/fixtures/profile-policy.ts")], {
      env: { ...env, PI_TEST_CLI: cli! }, encoding: "utf8", timeout: 35000,
    });
    assert.equal(policy.status, 0, `${policy.error ?? ""}\n${policy.stdout}\n${policy.stderr}`);
  } finally { closeSurface(surface); rmSync(root, { recursive: true, force: true }); }
});
