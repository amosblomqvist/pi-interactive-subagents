import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import * as ipc from "../pi-extension/subagents/interactive-ipc.ts";
import { createSurface, sendLongCommand, sendCommand, waitSurfaceReady, closeSurface, shellEscape } from "../pi-extension/subagents/surface.ts";

test("ACK and startup waits are asynchronous, bounded and fail on closed IPC, rejection and sidecar", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ipc-waits-"));
  const surface = createSurface("waits", { surfaceBackend: "process" });
  try {
    sendLongCommand(surface, "sleep 30", { scriptPath: join(root, "launch.sh"), interactive: { messages: [] } });
    const box = join(root, readdirSync(root).find(name => name.startsWith("pi-ipc-"))!);
    await assert.rejects(waitSurfaceReady(surface, { timeoutMs: 60 }), /ready.*timed out/i);
    let ready = false;
    const startup = waitSurfaceReady(surface, { timeoutMs: 1000 }).then(() => { ready = true; });
    await delay(30);
    assert.equal(ready, false);
    writeFileSync(join(box, "ready"), JSON.stringify({ mode: "tui" }));
    await startup;
    let accepted = false;
    const delivery = sendCommand(surface, "literal\nmessage", { timeoutMs: 1000 }).then(() => { accepted = true; });
    await delay(30);
    assert.equal(accepted, false, "publication is not acceptance");
    ipc.consumeMessages(box, () => {});
    await delivery;
    const rejected = sendCommand(surface, "reject", { timeoutMs: 1000 });
    ipc.consumeMessages(box, () => { throw new Error("API rejected fixture"); });
    await assert.rejects(rejected, /API rejected fixture/);
    await assert.rejects(sendCommand(surface, "uncertain", { timeoutMs: 60 }), /uncertain.*no automatic retry/i);
    assert.equal(readdirSync(box).filter(name => name.endsWith(".json")).length, 1);
    const sidecar = join(root, "session");
    writeFileSync(`${sidecar}.exit`, JSON.stringify({ type: "error", errorMessage: "fixture startup failed" }));
    await assert.rejects(waitSurfaceReady(surface, { sessionFile: sidecar, timeoutMs: 1000 }), /fixture startup failed/);
    const vanished = sendCommand(surface, "vanished", { timeoutMs: 1000 });
    ipc.closeMailbox(box);
    await assert.rejects(vanished, /IPC.*disappeared/);
    closeSurface(surface);
    await assert.rejects(waitSurfaceReady(surface, { timeoutMs: 1000 }), /closed/);
  } finally { closeSurface(surface); rmSync(root, { recursive: true, force: true }); }
});

test("missing util-linux script rejects readiness promptly and removes the mailbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "no-script-"));
  const surface = createSurface("missing-script", { surfaceBackend: "process" });
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    sendLongCommand(surface, "true", { scriptPath: join(root, "launch.sh"), interactive: { messages: [] } });
    process.env.PATH = previous;
    await assert.rejects(waitSurfaceReady(surface, { timeoutMs: 1000 }), /util-linux script.*ENOENT/);
    assert.equal(readdirSync(root).some(name => name.startsWith("pi-ipc-")), false);
  } finally { process.env.PATH = previous; closeSurface(surface); rmSync(root, { recursive: true, force: true }); }
});

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, "deadline exceeded"); await delay(20); }
}

test("private incarnation mailbox: atomic publication, identified ACK, literal multiline, no replay and invalid input", () => {
  const root = mkdtempSync(join(tmpdir(), "ipc-test-"));
  const box = ipc.createMailbox(root);
  const other = ipc.createMailbox(root);
  try {
    assert.notEqual(box, other);
    assert.equal(statSync(box).mode & 0o777, 0o700);
    const messages: unknown[] = [];
    const id = ipc.publishMessage(box, { message: "/danger\n  unchanged", deliverAs: "steer" });
    writeFileSync(join(box, "partial.tmp"), "{");
    writeFileSync(join(box, "bad.json"), "{");
    ipc.consumeMessages(box, (message) => messages.push(message));
    assert.deepEqual(messages, [{ message: "/danger\n  unchanged", deliverAs: "steer", expandPromptTemplates: false }]);
    assert.equal(JSON.parse(readFileSync(join(box, `${id}.ack`), "utf8")).status, "accepted");
    assert.equal(JSON.parse(readFileSync(join(box, "bad.ack"), "utf8")).status, "rejected");
    ipc.consumeMessages(box, () => assert.fail("replayed message"));
    const failed = ipc.publishMessage(box, { message: "rejected", deliverAs: "followUp" });
    ipc.consumeMessages(box, () => { throw new Error("API unavailable"); });
    assert.equal(JSON.parse(readFileSync(join(box, `${failed}.ack`), "utf8")).status, "rejected");
    assert.throws(() => ipc.publishMessage(box, { message: "/danger", deliverAs: "steer", expandPromptTemplates: true }));
    ipc.closeMailbox(box);
    assert.throws(() => ipc.publishMessage(box, { message: "late", deliverAs: "steer" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interactive surface owns a real PTY and forcibly closes TERM-resistant descendants", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pty-test-"));
  const surface = createSurface("pty-test", { surfaceBackend: "process" });
  const pidFile = join(root, "pid");
  const ttyFile = join(root, "tty");
  try {
    const code = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000)`;
    sendLongCommand(surface, `test -t 0 && test -t 1 && printf yes > ${shellEscape(ttyFile)}; ${shellEscape(process.execPath)} -e ${shellEscape(code)} & wait`, {
      scriptPath: join(root, "with ' quote.sh"), interactive: { messages: [] },
    });
    await until(() => existsSync(pidFile));
    assert.equal(readFileSync(ttyFile, "utf8"), "yes");
    const pid = Number(readFileSync(pidFile, "utf8"));
    closeSurface(surface);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch { return true; }
    });
  } finally { closeSurface(surface); rmSync(root, { recursive: true, force: true }); }
});
