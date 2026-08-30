import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcClient, type RpcTransport } from "../pi-extension/subagents/rpc-client.ts";
import {
  buildRpcArgv,
  buildRpcPrompts,
  expandFileRefForRpc,
  closeAllRpcSurfaces,
  closeRpcSurface,
  createRpcSurface,
  pollRpcForExit,
  readRpcScreen,
  readRpcTranscript,
  resolvePiCommand,
  sendRpcCommand,
  __rpcTest__,
} from "../pi-extension/subagents/rpc.ts";
import {
  closeSurfaceAny,
  isRpcSurface,
  loadSurfaceConfig,
  parseSurfaceConfig,
  pollSurfaceForExit,
  readSurfaceScreen,
  resolveSurfaceBackend,
  sendSurfaceCommand,
  type ChildLaunchSpec,
} from "../pi-extension/subagents/surface.ts";
import type { SubagentLoadout } from "../pi-extension/subagents/session.ts";
import { isTmuxAvailable } from "../pi-extension/subagents/tmux.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const testApi = subagentsModule.__test__;

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url));

let tmpRoot = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll pred() until true; throws after timeoutMs so failures don't hang the run. */
async function waitFor(pred: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await sleep(intervalMs);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      (timer as any).unref?.();
    }),
  ]);
}

/** In-memory RpcTransport — records sent commands, lets tests inject events. */
class FakeTransport implements RpcTransport {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  exited = false;
  exitCode: number | null = null;
  private eventHandlers = new Set<(event: any) => void>();
  private responseHandlers = new Set<(response: any) => void>();
  private exitHandlers = new Set<(code: number | null) => void>();

  send(command: Record<string, unknown>): void {
    this.sent.push(command);
  }

  close(): void {
    this.closed = true;
  }

  onEvent(handler: (event: any) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onResponse(handler: (response: any) => void): () => void {
    this.responseHandlers.add(handler);
    return () => this.responseHandlers.delete(handler);
  }

  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  emitEvent(event: any): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  emitResponse(response: any): void {
    for (const handler of this.responseHandlers) handler(response);
  }

  emitExit(code: number): void {
    this.exited = true;
    this.exitCode = code;
    for (const handler of this.exitHandlers) handler(code);
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((c) => (c as any).type === type);
  }
}

/**
 * Wraps a real RpcClient, recording every command sent down the wire. The
 * surface talks to the wrapper (it satisfies RpcTransport), so integration
 * tests see exactly what a real child received.
 */
class RecordingTransport implements RpcTransport {
  readonly sent: Record<string, unknown>[] = [];
  constructor(private inner: RpcTransport) {}
  send(command: Record<string, unknown>): void {
    this.sent.push(command);
    this.inner.send(command);
  }
  close(): void {
    this.inner.close();
  }
  get exited(): boolean {
    return this.inner.exited;
  }
  get exitCode(): number | null {
    return this.inner.exitCode;
  }
  onEvent(handler: (event: any) => void): () => void {
    return this.inner.onEvent(handler);
  }
  onResponse(handler: (response: any) => void): () => void {
    return this.inner.onResponse(handler);
  }
  onExit(handler: (code: number | null) => void): () => void {
    return this.inner.onExit(handler);
  }
  sentMessages(): unknown[] {
    return this.sent.map((c) => (c as any).message);
  }
}

/**
 * Prompt commands carry a uuid-based correlation id (asserted separately);
 * queue-ordering assertions compare the stable projection of each command.
 */
function promptProjection(commands: Record<string, unknown>[]): { type: string; message: unknown }[] {
  return commands.map((c) => ({ type: c.type as string, message: c.message }));
}

function makeLoadout(overrides: Partial<SubagentLoadout> = {}): SubagentLoadout {
  return {
    agent: null,
    toolAllowlist: null,
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: true,
    cwd: null,
    agentDir: null,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ChildLaunchSpec> = {}): ChildLaunchSpec {
  return {
    kind: "pi",
    sessionFile: join(tmpRoot, "sess.json"),
    subagentDonePath: join(tmpRoot, "subagent-done.ts"),
    loadout: makeLoadout(),
    artifactDir: tmpRoot,
    name: "worker",
    env: {},
    cwd: null,
    prompts: [],
    rpcPrompts: [],
    ...overrides,
  };
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-rpc-test-"));
});

after(async () => {
  closeAllRpcSurfaces();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ── RpcClient (real child process, fixture protocol) ─────────────────────────

describe("RpcClient", () => {
  it("correlates responses by id", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    try {
      const response = await withTimeout(client.request({ type: "ping" }), 5000, "ping timed out");
      assert.equal(response.success, true);
      assert.equal(response.command, "ping");
      assert.equal(response.data?.pong, true);
      // The auto-id our client assigned is the one that came back.
      assert.equal(typeof response.id, "string");
      assert.ok(response.id.startsWith("rpc-"));
    } finally {
      client.close();
    }
  });

  it("survives U+2028 inside a JSON payload (LF-only framing)", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    try {
      const events: any[] = [];
      client.onEvent((event) => events.push(event));
      client.send({ type: "emit-u2028" });
      await waitFor(() =>
        events.some(
          (e) => e.type === "message_end" && e.message?.content?.[0]?.text === "a" + String.fromCharCode(0x2028) + "b",
        ),
      );
    } finally {
      client.close();
    }
  });

  it("ignores non-JSON lines on stdout", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    try {
      client.send({ type: "garbage" });
      // The channel keeps working after garbage.
      const response = await withTimeout(client.request({ type: "ping" }), 5000, "ping timed out");
      assert.equal(response.success, true);
    } finally {
      client.close();
    }
  });

  it("routes stderr to synthetic __stderr events", async () => {
    const client = RpcClient.spawn(
      process.execPath,
      ["-e", 'process.stderr.write("child stderr line\\n"); setTimeout(() => {}, 50)'],
      {},
    );
    try {
      const events: any[] = [];
      client.onEvent((event) => events.push(event));
      await waitFor(() => events.some((e) => e.type === "__stderr" && e.line === "child stderr line"));
    } finally {
      client.close();
    }
  });

  it("observes child exit code", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    try {
      client.send({ type: "die" });
      await waitFor(() => client.exited, 5000);
      assert.equal(client.exitCode, 3);
    } finally {
      client.close();
    }
  });

  it("close() terminates a live child", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    // Prove the child is up and answering before killing it.
    const response = await withTimeout(client.request({ type: "ping" }), 5000, "ping timed out");
    assert.equal(response.success, true);
    client.close();
    await waitFor(() => client.exited, 5000);
  });
});

// ── Real-child integration (fixture through the real dispatch path) ───────────
// FakeTransport.emitResponse bypasses RpcClient.dispatch, so these tests prove
// the id routing end to end: a real child's id-echoed rejection must reach
// handleRpcResponse, free the queue, and land in the transcript.

describe("RpcClient ↔ surface integration", () => {
  it("a real rejection flows through dispatch: transcript ✗ line + queue recovery", async () => {
    const client = RpcClient.spawn(process.execPath, [FIXTURE], {});
    const transport = new RecordingTransport(client);
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["fail:no api key", "then this"] }), {
      autoExit: false,
      transport,
    });
    try {
      // The fixture rejects the first prompt with an id-echoed failure — the
      // real RpcClient.dispatch must route it to onResponse, handleRpcResponse
      // must free the queue, and prompt two must go out. This is the exact
      // path that froze before prompts carried ids.
      await waitFor(
        () => readRpcScreen(surface).includes("prompt rejected: simulated rejection: no api key"),
        5000,
        "rejection never reached the transcript",
      );
      // Queue recovery: prompt two was delivered after the rejection.
      await waitFor(
        () => transport.sentMessages().includes("then this"),
        5000,
        "second prompt never sent after the rejection",
      );
      // The surface is not wedged: a steer still goes out.
      sendRpcCommand(surface, "after recovery");
      await waitFor(
        () => transport.sentMessages().includes("after recovery"),
        5000,
        "steer after recovery never sent",
      );
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("flushes a stderr tail that never got its trailing newline", async () => {
    const client = RpcClient.spawn(
      process.execPath,
      ["-e", 'process.stderr.write("tail without newline")'],
      {},
    );
    try {
      const events: any[] = [];
      client.onEvent((event) => events.push(event));
      await waitFor(() => client.exited, 5000);
      // The child died before writing a newline; close() must still deliver
      // the buffered partial line instead of dropping it.
      await waitFor(() => events.some((e) => e.type === "__stderr" && e.line === "tail without newline"), 2000);
    } finally {
      client.close();
    }
  });

  it("reports an unspawnable binary as a __spawn_error event", async () => {
    const client = RpcClient.spawn("/definitely/not/a/real/binary", [], {});
    try {
      const events: any[] = [];
      client.onEvent((event) => events.push(event));
      await waitFor(() => events.some((e) => e.type === "__spawn_error"), 5000);
      const spawnError = events.find((e) => e.type === "__spawn_error");
      assert.match(spawnError.message, /failed to start/);
      assert.match(spawnError.message, /definitely\/not\/a\/real\/binary/);
    } finally {
      client.close();
    }
  });
});

// ── RPC surface state machine (FakeTransport injection) ──────────────────────

describe("RPC surface prompt queue", () => {
  it("delivers prompts one run at a time, in order", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(
      makeSpec({ rpcPrompts: ["first", "second"], env: {} }),
      { autoExit: false, transport },
    );
    try {
      // Only the first prompt is sent; the second waits for agent_end.
      assert.deepEqual(promptProjection(transport.sent), [{ type: "prompt", message: "first" }]);

      transport.emitEvent({ type: "agent_start" });
      assert.equal(transport.sent.length, 1); // run active — nothing new

      transport.emitEvent({ type: "agent_end", willRetry: false });
      assert.deepEqual(promptProjection(transport.sent), [
        { type: "prompt", message: "first" },
        { type: "prompt", message: "second" },
      ]);
      // Distinct runs get distinct correlation ids.
      assert.notEqual((transport.sent[0] as any).id, (transport.sent[1] as any).id);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("steer commands queue behind the running prompt", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["task"] }), {
      autoExit: false,
      transport,
    });
    try {
      transport.emitEvent({ type: "agent_start" });
      sendRpcCommand(surface, "please also check the tests");
      assert.equal(transport.sent.length, 1); // still parked

      transport.emitEvent({ type: "agent_end", willRetry: false });
      assert.deepEqual(promptProjection(transport.sent.slice(1)), [
        { type: "prompt", message: "please also check the tests" },
      ]);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("a rejected prompt frees the queue and records the error", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["a", "b"] }), {
      autoExit: false,
      transport,
    });
    try {
      transport.emitResponse({ type: "response", command: "prompt", success: false, error: "nope" });
      assert.deepEqual(transport.sent.map((c) => (c as any).message), ["a", "b"]);
      assert.match(readRpcScreen(surface), /prompt rejected: nope/);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("ignores a rejection whose id does not match the in-flight prompt", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["a"] }), {
      autoExit: false,
      transport,
    });
    try {
      const inflight = (transport.sent[0] as any).id;
      // A stale rejection (id from a previous, already-retired prompt) must
      // not poison lastError or requeue anything.
      transport.emitResponse({
        type: "response",
        id: `${inflight}-stale`,
        command: "prompt",
        success: false,
        error: "stale rejection",
      });
      assert.equal(transport.sent.length, 1);
      assert.equal(readRpcScreen(surface), "");
      // The matching rejection does free the queue.
      transport.emitResponse({
        type: "response",
        id: inflight,
        command: "prompt",
        success: false,
        error: "real rejection",
      });
      assert.match(readRpcScreen(surface), /prompt rejected: real rejection/);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("throws on steer once the child has exited (no silent drop)", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: [] }), {
      autoExit: false,
      transport,
    });
    try {
      transport.emitExit(0);
      assert.throws(() => sendRpcCommand(surface, "too late"), /has exited/);
      assert.equal(transport.sent.length, 0);
    } finally {
      closeRpcSurface(surface);
    }
    // Unknown surfaces throw too — steer callers must report the failure.
    assert.throws(() => sendRpcCommand("rpc:nope", "anyone"), /no longer exists/);
  });

  it("sends prompts with a correlation id", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["task"] }), {
      autoExit: false,
      transport,
    });
    try {
      const command = transport.sent[0] as any;
      assert.equal(command.type, "prompt");
      assert.equal(command.message, "task");
      assert.ok(typeof command.id === "string" && command.id.length > 0);
    } finally {
      closeRpcSurface(surface);
    }
  });
});

describe("RPC surface reap-nudge", () => {
  it("arms the nudge after a final-looking agent_end (pre-0.80.4 children)", async () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["only"] }), {
      autoExit: true,
      transport,
      nudgeDelayMs: 10,
    });
    try {
      transport.emitEvent({ type: "agent_start" });
      transport.emitEvent({ type: "agent_end", willRetry: false });
      await sleep(60);
      assert.ok(
        transport.sent.some((c) => (c as any).type === "get_last_assistant_text"),
        "nudge command was not sent",
      );
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("skips the nudge once the child emits agent_settled (0.80.4+)", async () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["only"] }), {
      autoExit: true,
      transport,
      nudgeDelayMs: 10,
    });
    try {
      transport.emitEvent({ type: "agent_start" });
      transport.emitEvent({ type: "agent_settled" });
      transport.emitEvent({ type: "agent_end", willRetry: false });
      await sleep(60);
      assert.equal(transport.sentOfType("get_last_assistant_text").length, 0);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("cancels an armed nudge when a new run starts", async () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["only"] }), {
      autoExit: true,
      transport,
      nudgeDelayMs: 25,
    });
    try {
      transport.emitEvent({ type: "agent_start" });
      transport.emitEvent({ type: "agent_end", willRetry: false });
      // New activity (e.g. a steer delivered as a fresh prompt) before the
      // delay elapses must cancel the nudge.
      sendRpcCommand(surface, "one more thing");
      await sleep(80);
      assert.equal(transport.sentOfType("get_last_assistant_text").length, 0);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("skips the nudge while prompts remain queued", async () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["a"] }), {
      autoExit: true,
      transport,
      nudgeDelayMs: 10,
    });
    try {
      transport.emitEvent({ type: "agent_start" });
      sendRpcCommand(surface, "follow-up"); // parked behind the active run
      transport.emitEvent({ type: "agent_end", willRetry: false });
      await sleep(60);
      // The follow-up was delivered, and no nudge fired while it was queued.
      assert.deepEqual(promptProjection(transport.sent.slice(1)), [
        { type: "prompt", message: "follow-up" },
      ]);
      assert.equal(transport.sentOfType("get_last_assistant_text").length, 0);
    } finally {
      closeRpcSurface(surface);
    }
  });
});

describe("RPC surface transcript", () => {
  it("mirrors the interesting parts of the event stream", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: [] }), {
      autoExit: false,
      transport,
    });
    try {
      transport.emitEvent({
        type: "message_start",
        message: { role: "user", content: "do the thing\nline two" },
      });
      transport.emitEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "working on it\nalmost done" }] },
      });
      transport.emitEvent({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: "ls -la /tmp\ngoodbye" },
      });
      transport.emitEvent({ type: "tool_execution_end", toolName: "bash", isError: true });
      transport.emitEvent({ type: "__stderr", line: "warning: disk nearly full" });

      const screen = readRpcScreen(surface);
      assert.match(screen, /> do the thing/); // first line of the user message only
      assert.match(screen, /almost done/); // last assistant lines
      assert.match(screen, /● bash \(ls -la \/tmp\)/); // first arg line, truncated
      assert.match(screen, /✗ bash failed/);
      assert.match(screen, /warning: disk nearly full/);
    } finally {
      closeRpcSurface(surface);
    }
  });

  it("caps the transcript at maxTranscriptLines", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: [] }), {
      autoExit: false,
      transport,
      maxTranscriptLines: 2,
    });
    try {
      for (const text of ["one", "two", "three"]) {
        transport.emitEvent({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      }
      assert.equal(readRpcScreen(surface), "two\nthree");
      assert.deepEqual(readRpcTranscript(surface, 1), ["three"]);
    } finally {
      closeRpcSurface(surface);
    }
  });
});

// ── Exit polling ─────────────────────────────────────────────────────────────

describe("pollRpcForExit", () => {
  it("resolves from the .exit sidecar with the child's error message", async () => {
    const sessionFile = join(tmpRoot, "sidecar-session.json");
    const transport = new FakeTransport();
    __rpcTest__.registerRpcSurface("rpc:poll-sidecar", transport, { autoExit: false });
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: "error", errorMessage: "provider exploded" }),
      "utf8",
    );
    try {
      const result = await withTimeout(
        pollRpcForExit("rpc:poll-sidecar", new AbortController().signal, {
          interval: 5,
          sessionFile,
        }),
        2000,
        "poll timed out",
      );
      assert.deepEqual(result, { reason: "error", exitCode: 1, errorMessage: "provider exploded" });
      assert.equal(existsSync(`${sessionFile}.exit`), false); // sidecar consumed
    } finally {
      closeRpcSurface("rpc:poll-sidecar");
    }
  });

  it("treats a clean process exit as done", async () => {
    const transport = new FakeTransport();
    __rpcTest__.registerRpcSurface("rpc:poll-done", transport, { autoExit: false });
    transport.emitExit(0);
    try {
      const result = await withTimeout(
        pollRpcForExit("rpc:poll-done", new AbortController().signal, { interval: 5 }),
        2000,
        "poll timed out",
      );
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      closeRpcSurface("rpc:poll-done");
    }
  });

  it("treats a crashed process as an error, surfacing lastError when known", async () => {
    const transport = new FakeTransport();
    __rpcTest__.registerRpcSurface("rpc:poll-crash", transport, { autoExit: false });
    transport.emitEvent({ type: "error", error: "child exploded" });
    transport.emitExit(1);
    try {
      const result = await withTimeout(
        pollRpcForExit("rpc:poll-crash", new AbortController().signal, { interval: 5 }),
        2000,
        "poll timed out",
      );
      assert.deepEqual(result, { reason: "error", exitCode: 1, errorMessage: "child exploded" });
    } finally {
      closeRpcSurface("rpc:poll-crash");
    }
  });

  it("reports a generic message when a crash carries no lastError", async () => {
    const transport = new FakeTransport();
    __rpcTest__.registerRpcSurface("rpc:poll-crash-silent", transport, { autoExit: false });
    transport.emitExit(2);
    try {
      const result = await withTimeout(
        pollRpcForExit("rpc:poll-crash-silent", new AbortController().signal, { interval: 5 }),
        2000,
        "poll timed out",
      );
      assert.deepEqual(result, {
        reason: "error",
        exitCode: 2,
        errorMessage: "RPC subagent process exited with code 2",
      });
    } finally {
      closeRpcSurface("rpc:poll-crash-silent");
    }
  });

  it("treats an unknown surface as a clean exit", async () => {
    const result = await withTimeout(
      pollRpcForExit("rpc:never-registered", new AbortController().signal, { interval: 5 }),
      2000,
      "poll timed out",
    );
    assert.deepEqual(result, { reason: "done", exitCode: 0 });
  });

  it("aborts when the signal fires", async () => {
    const transport = new FakeTransport();
    __rpcTest__.registerRpcSurface("rpc:poll-abort", transport, { autoExit: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20).unref();
    try {
      await withTimeout(
        pollRpcForExit("rpc:poll-abort", controller.signal, { interval: 10 }),
        2000,
        "poll timed out",
      );
      assert.fail("expected the poll to abort");
    } catch (error: any) {
      assert.match(error.message, /abort/i);
    } finally {
      closeRpcSurface("rpc:poll-abort");
    }
  });
});

// ── Surface dispatch (id-prefix routing) ──────────────────────────────────────

describe("surface dispatch", () => {
  it("classifies surface ids by prefix", () => {
    assert.equal(isRpcSurface("rpc:abc-123"), true);
    assert.equal(isRpcSurface("%12"), false);
    assert.equal(isRpcSurface(""), false);
  });

  it("routes commands, reads, closes, and polls through the prefix", async () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: ["go"] }), {
      autoExit: false,
      transport,
    });
    try {
      assert.ok(surface.startsWith("rpc:"));

      sendSurfaceCommand(surface, "keep going");
      assert.equal(transport.sent.length, 1); // parked behind the initial prompt
      transport.emitEvent({ type: "agent_end", willRetry: false });
      assert.deepEqual(promptProjection(transport.sent.slice(1)), [
        { type: "prompt", message: "keep going" },
      ]);

      transport.emitEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      assert.equal(readSurfaceScreen(surface), "done");

      transport.emitExit(0);
      const result = await withTimeout(
        pollSurfaceForExit(surface, new AbortController().signal, { interval: 5 }),
        2000,
        "poll timed out",
      );
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      closeSurfaceAny(surface);
    }
    assert.equal(readSurfaceScreen(surface), ""); // closed surfaces read empty
  });

  it("closeSurfaceAny closes the transport for rpc surfaces", () => {
    const transport = new FakeTransport();
    const surface = createRpcSurface(makeSpec({ rpcPrompts: [] }), {
      autoExit: false,
      transport,
    });
    closeSurfaceAny(surface);
    assert.equal(transport.closed, true);
  });
});

// ── Backend selection ─────────────────────────────────────────────────────────

describe("backend selection", () => {
  it("parses the config surface block leniently", () => {
    assert.deepEqual(parseSurfaceConfig({ surface: { backend: "rpc" } }), { backend: "rpc" });
    assert.deepEqual(parseSurfaceConfig({ surface: { backend: "tmux" } }), { backend: "tmux" });
    assert.deepEqual(parseSurfaceConfig({ surface: { backend: "auto" } }), { backend: "auto" });
    assert.deepEqual(parseSurfaceConfig({ surface: { backend: "bogus" } }), { backend: "auto" });
    assert.deepEqual(parseSurfaceConfig({}), { backend: "auto" });
    assert.deepEqual(parseSurfaceConfig(null), { backend: "auto" });
  });

  it("lets PI_SUBAGENT_SURFACE and PI_SUBAGENT_PANES override the config", () => {
    const previousSurface = process.env.PI_SUBAGENT_SURFACE;
    const previousPanes = process.env.PI_SUBAGENT_PANES;
    try {
      process.env.PI_SUBAGENT_SURFACE = "rpc";
      process.env.PI_SUBAGENT_PANES = "0";
      const config = loadSurfaceConfig();
      assert.equal(config.backend, "rpc");
      assert.equal(config.panesEnabled, false);

      process.env.PI_SUBAGENT_SURFACE = "tmux";
      process.env.PI_SUBAGENT_PANES = "1";
      const config2 = loadSurfaceConfig();
      assert.equal(config2.backend, "tmux");
      assert.equal(config2.panesEnabled, true);

      process.env.PI_SUBAGENT_SURFACE = "nonsense";
      const config3 = loadSurfaceConfig();
      assert.equal(config3.backend, "auto"); // unknown env values never win

      // Surface ids inherited from a parent are not backend choices — they
      // say what kind of child *we* are, so our spawns stay in kind.
      process.env.PI_SUBAGENT_SURFACE = "rpc:parent-run-7";
      const config4 = loadSurfaceConfig();
      assert.equal(config4.backend, "rpc"); // we are headless → our spawns too

      process.env.PI_SUBAGENT_SURFACE = "%5";
      const config5 = loadSurfaceConfig();
      assert.equal(config5.backend, "tmux"); // we are a pane child → panes
    } finally {
      if (previousSurface === undefined) delete process.env.PI_SUBAGENT_SURFACE;
      else process.env.PI_SUBAGENT_SURFACE = previousSurface;
      if (previousPanes === undefined) delete process.env.PI_SUBAGENT_PANES;
      else process.env.PI_SUBAGENT_PANES = previousPanes;
    }
  });

  it("resolves backends: claude pins tmux, explicit beats auto", () => {
    const autoConfig = { backend: "auto" as const, panesEnabled: true };
    assert.equal(resolveSurfaceBackend("claude", { backend: "rpc", panesEnabled: true }), "tmux");
    assert.equal(resolveSurfaceBackend("pi", { backend: "tmux", panesEnabled: true }), "tmux");
    assert.equal(resolveSurfaceBackend("pi", { backend: "rpc", panesEnabled: true }), "rpc");
    // "auto" keeps the historical behavior inside tmux and goes headless outside.
    assert.equal(
      resolveSurfaceBackend("pi", autoConfig),
      isTmuxAvailable() ? "tmux" : "rpc",
    );
    // No agent type means pi (the only RPC-capable CLI).
    assert.equal(resolveSurfaceBackend(undefined, autoConfig), isTmuxAvailable() ? "tmux" : "rpc");
  });
});

// ── pi command + argv construction ────────────────────────────────────────────

describe("resolvePiCommand", () => {
  const previous = process.env.PI_SUBAGENT_BIN;
  after(() => {
    if (previous === undefined) delete process.env.PI_SUBAGENT_BIN;
    else process.env.PI_SUBAGENT_BIN = previous;
  });

  it("honors PI_SUBAGENT_BIN with and without arguments", () => {
    process.env.PI_SUBAGENT_BIN = "node /opt/pi/dist/pi.js";
    assert.deepEqual(resolvePiCommand(), { command: "node", args: ["/opt/pi/dist/pi.js"] });

    process.env.PI_SUBAGENT_BIN = "/usr/local/bin/pi";
    assert.deepEqual(resolvePiCommand(), { command: "/usr/local/bin/pi", args: [] });

    process.env.PI_SUBAGENT_BIN = "  spaced   out  ";
    assert.deepEqual(resolvePiCommand(), { command: "spaced", args: ["out"] });
  });
});

describe("buildRpcArgv", () => {
  it("builds the base argv: mode, session, done-path", () => {
    const spec = makeSpec();
    assert.deepEqual(buildRpcArgv(spec), [
      "--mode",
      "rpc",
      "--session",
      spec.sessionFile,
      "-e",
      spec.subagentDonePath,
    ]);
  });

  it("appends model, thinking, identity flag, and default-deny flags in order", () => {
    const spec = makeSpec({
      loadout: makeLoadout({
        model: "grok-code",
        thinking: "high",
        identity: "You are the test runner.",
        systemPromptMode: "append",
        toolAllowlist: "bash,edit",
      }),
    });
    const argv = buildRpcArgv(spec);
    assert.deepEqual(argv.slice(0, 6), [
      "--mode",
      "rpc",
      "--session",
      spec.sessionFile,
      "-e",
      spec.subagentDonePath,
    ]);
    assert.deepEqual(argv.slice(6, 8), ["--model", "grok-code:high"]);
    assert.equal(argv[8], "--append-system-prompt");
    assert.ok(argv[9].endsWith("-sysprompt-.md") || argv[9].includes("sysprompt-"));
    // The identity file was actually written (same content, same naming scheme
    // as the tmux renderer).
    const identity = readFileSync(argv[9], "utf8");
    assert.equal(identity, "You are the test runner.");
    assert.deepEqual(argv.slice(10), ["--no-extensions", "--tools", "bash,edit"]);
  });

  it("uses --system-prompt for replace mode", () => {
    const spec = makeSpec({
      loadout: makeLoadout({ identity: "You replace everything.", systemPromptMode: "replace" }),
    });
    // No model in this loadout: [--mode, rpc, --session, s, -e, d, --system-prompt, path]
    assert.equal(buildRpcArgv(spec)[6], "--system-prompt");
  });
});

describe("buildRpcPrompts", () => {
  it("direct delivery: skills first, then the raw task", () => {
    assert.deepEqual(
      buildRpcPrompts({ effectiveSkills: " testing , code-review ", taskDelivery: "direct", taskArg: "fix the bug" }),
      ["/skill:testing", "/skill:code-review", "fix the bug"],
    );
    assert.deepEqual(
      buildRpcPrompts({ taskDelivery: "direct", taskArg: "just this" }),
      ["just this"],
    );
  });

  it("artifact delivery: inlines the @file task the way pi's CLI would, skills follow", () => {
    const taskFile = join(tmpRoot, "task-artifact.md");
    writeFileSync(taskFile, "Read the spec in @attached.\n", "utf8");
    // Byte-identical to pi's cli/file-processor.ts expansion so an rpc child
    // sees the same task — provenance included — as a pane child.
    assert.deepEqual(
      buildRpcPrompts({ effectiveSkills: "testing", taskDelivery: "artifact", taskArg: `@${taskFile}` }),
      [`<file name="${taskFile}">\nRead the spec in @attached.\n\n</file>\n`, "/skill:testing"],
    );
  });

  it("expandFileRefForRpc wraps files, resolves paths, and passes through non-refs", () => {
    const refFile = join(tmpRoot, "expand-ref.md");
    writeFileSync(refFile, "payload\n", "utf8");
    assert.equal(
      expandFileRefForRpc(`@${refFile}`),
      `<file name="${refFile}">\npayload\n\n</file>\n`,
    );
    // Non-@ strings and unreadable files pass through untouched.
    assert.equal(expandFileRefForRpc("plain text"), "plain text");
    assert.equal(expandFileRefForRpc("@/no/such/file.md"), "@/no/such/file.md");
  });

  it("artifact delivery with an unreadable @ref delivers the reference verbatim", () => {
    assert.deepEqual(
      buildRpcPrompts({ taskDelivery: "artifact", taskArg: "@/no/such/file.md" }),
      ["@/no/such/file.md"],
    );
  });

  it("artifact delivery with plain text passes it through", () => {
    assert.deepEqual(
      buildRpcPrompts({ taskDelivery: "artifact", taskArg: "plain task text" }),
      ["plain task text"],
    );
  });
});

// ── tmux renderer (byte-identity pin) ─────────────────────────────────────────
// renderTmuxCommand must keep producing the exact shell string the pre-spec
// code produced: the tmux backend is the fallback everywhere, and users have
// scripts and muscle memory against the launch artifacts.

describe("renderTmuxCommand", () => {
  it("renders the full launch: cd prefix, env in insertion order, AUTO_EXIT unquoted", () => {
    const spec = makeSpec({
      sessionFile: "/tmp/sess.json",
      subagentDonePath: "/ext/subagents/subagent-done.ts",
      loadout: makeLoadout({ model: "m2", thinking: "high" }),
      artifactDir: "/tmp/art",
      name: "Data Worker",
      env: { PI_SUBAGENT_NAME: "data worker", PI_SUBAGENT_AUTO_EXIT: "1" },
      cwd: "/tmp/work",
      prompts: ["", "/skill:alpha", "@task.md"],
    });
    assert.equal(
      testApi.renderTmuxCommand(spec),
      "cd '/tmp/work' && PI_SUBAGENT_NAME='data worker' PI_SUBAGENT_AUTO_EXIT=1 " +
        "pi --session '/tmp/sess.json' -e '/ext/subagents/subagent-done.ts' --model 'm2:high' " +
        "'' '/skill:alpha' '@task.md'; echo '__SUBAGENT_DONE_'$?'__'",
    );
  });

  it("renders a minimal launch with no cwd, env, or loadout extras", () => {
    const spec = makeSpec({
      sessionFile: "/tmp/s.json",
      subagentDonePath: "/tmp/d.ts",
      prompts: ["just this"],
    });
    // Historical quirk pinned: envPrefix is `join(" ") + " "`, so an empty env
    // leaves a leading space (production launches always set env vars).
    assert.equal(
      testApi.renderTmuxCommand(spec),
      " pi --session '/tmp/s.json' -e '/tmp/d.ts' 'just this'; echo '__SUBAGENT_DONE_'$?'__'",
    );
  });

  it("keeps env insertion order and quotes values", () => {
    const spec = makeSpec({
      env: { Z_VAR: "z", A_VAR: "it's quoted", M_VAR: "multi word" } as Record<string, string>,
      prompts: [],
    });
    assert.ok(testApi.renderTmuxCommand(spec).startsWith(
      // shellEscape wraps in single quotes and re-quotes embedded quotes.
      "Z_VAR='z' A_VAR='it'\\''s quoted' M_VAR='multi word' pi ",
    ));
  });

  it("writes the identity file and emits replace/append flags plus default-deny", () => {
    const artifactDir = join(tmpRoot, "identity-art");
    const spec = makeSpec({
      sessionFile: "/tmp/c.json",
      subagentDonePath: "/tmp/dd.ts",
      artifactDir,
      name: "Web Research",
      loadout: makeLoadout({
        identity: "You are the web researcher.",
        systemPromptMode: "replace",
        toolAllowlist: "bash,edit",
      }),
      prompts: ["go"],
    });
    const out = testApi.renderTmuxCommand(spec);
    // Leading space = the empty-env quirk (see the minimal-launch test).
    assert.ok(
      out.startsWith(" pi --session '/tmp/c.json' -e '/tmp/dd.ts' --system-prompt '"),
      `unexpected prefix: ${out}`,
    );
    assert.ok(out.includes("context/web-research-sysprompt-"));
    assert.ok(
      out.endsWith("--no-extensions --tools 'bash,edit' 'go'; echo '__SUBAGENT_DONE_'$?'__'"),
      `unexpected suffix: ${out}`,
    );
    const pathMatch = out.match(/--system-prompt '([^']+)'/);
    assert.ok(pathMatch, "identity path not found");
    assert.equal(existsSync(pathMatch[1]), true);
    assert.equal(readFileSync(pathMatch[1], "utf8"), "You are the web researcher.");
  });
});

describe("safeArtifactName", () => {
  it("lowercases, strips unsafe characters, and falls back", () => {
    assert.equal(testApi.safeArtifactName("Web Research (v2)!", "subagent"), "web-research-v2");
    assert.equal(testApi.safeArtifactName("", "fallback"), "fallback");
    assert.equal(testApi.safeArtifactName(undefined, "fallback"), "fallback");
    assert.equal(testApi.safeArtifactName("???!!!", "fallback"), "fallback");
  });
});