import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DELEGATION_LIMITS,
  ensureLineageLedger,
  readLineageLedger,
  reconcileLineageLedger,
  releaseLineageLaunch,
  reserveLineageLaunch,
  setLineageLaunchOwner,
  touchLineageLaunch,
} from "../pi-extension/subagents/lineage.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-lineage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "lineage.json");
}

function activityFile(file: string, id: string): string {
  return join(dirname(file), "subagent-activity", `${id}.json`);
}

test("version-one active records migrate a missing owner instance without resetting accounting", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  await reserveLineageLaunch(file, {
    id: "child", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "safe.jsonl", activityFile: activityFile(file, "child"), ownerPid: process.pid,
    task: "legacy", kind: "launch",
  });
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.active.child.ownerInstance;
  writeFileSync(file, JSON.stringify(legacy));
  assert.equal(readLineageLedger(file)?.active.child.ownerInstance, null);
  const migrated = await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: false });
  assert.equal(migrated.launchesUsed, 1);
  assert.equal(migrated.active.child.token, legacy.active.child.token);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).active.child.ownerInstance, null);
  for (const malformed of [false, 42, [], {}]) {
    legacy.active.child.ownerInstance = malformed;
    writeFileSync(file, JSON.stringify(legacy));
    assert.equal(readLineageLedger(file), null);
    await assert.rejects(
      ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: false }),
      /invalid|corrupt/i,
    );
  }
});

test("defaults keep depth and concurrency bounded while cumulative launches are unlimited", () => {
  assert.deepEqual(DEFAULT_DELEGATION_LIMITS, {
    maxDepth: 2,
    maxConcurrentDescendants: 4,
    maxLaunchesPerLineage: null,
  });
});

test("default lineage permits more than twelve sequential launches and resumes", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });

  for (let index = 0; index < 13; index++) {
    const id = `child-${index}`;
    const lease = await reserveLineageLaunch(file, {
      id, parentId: null, name: "worker", agent: "worker", depth: 1,
      sessionFile: `${id}.jsonl`, activityFile: activityFile(file, id), ownerPid: process.pid,
      task: `launch ${index}`, kind: "launch",
    });
    await releaseLineageLaunch(file, lease.id, lease.token);
  }

  const resumed = await reserveLineageLaunch(file, {
    id: "child-0", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "child-0.jsonl", activityFile: activityFile(file, "child-0"), ownerPid: process.pid,
    task: "resume after twelve", kind: "resume",
  });
  await releaseLineageLaunch(file, resumed.id, resumed.token);

  const ledger = readLineageLedger(file)!;
  assert.equal(ledger.launchesUsed, 14);
  assert.equal(ledger.descendants["child-0"]!.launches, 2);
  assert.equal(ledger.limits.maxLaunchesPerLineage, null);
});

test("inherited sessions cannot recreate a missing ledger with zero usage", async (t) => {
  const file = fixture(t);
  await assert.rejects(
    ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: false }),
    /inherited.*missing.*refusing to recreate zeroed accounting/i,
  );
  assert.equal(existsSync(file), false);
});

test("unsafe lineage identities and escaped activity paths fail before persistence", async (t) => {
  const unsafeFile = fixture(t);
  await assert.rejects(
    ensureLineageLedger(unsafeFile, "../../escaped", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true }),
    /unsafe subagent lineage id/i,
  );

  const file = fixture(t);
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "../../escaped", parentId: null, name: "worker", agent: "worker", depth: 1,
      sessionFile: "safe.jsonl", activityFile: join(dirname(file), "escaped.json"), ownerPid: process.pid,
      task: "unsafe", kind: "launch",
    }),
    /safe identifier characters/i,
  );
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "safe-id", parentId: null, name: "worker", agent: "worker", depth: 1,
      sessionFile: "safe.jsonl", activityFile: join(dirname(file), "..", "escaped.json"), ownerPid: process.pid,
      task: "unsafe", kind: "launch",
    }),
    /activity path escapes/i,
  );
  assert.equal(readLineageLedger(file)!.launchesUsed, 0);

  await reserveLineageLaunch(file, {
    id: "safe-record", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "safe.jsonl", activityFile: activityFile(file, "safe-record"), ownerPid: process.pid,
    task: "safe", kind: "launch",
  });
  const tampered = JSON.parse(readFileSync(file, "utf8"));
  tampered.descendants["../../escaped"] = { ...tampered.descendants["safe-record"], id: "../../escaped" };
  tampered.active["../../escaped"] = { ...tampered.active["safe-record"], id: "../../escaped" };
  delete tampered.descendants["safe-record"];
  delete tampered.active["safe-record"];
  writeFileSync(file, JSON.stringify(tampered));
  assert.equal(readLineageLedger(file), null);
  await assert.rejects(
    ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true }),
    /invalid.*refusing to reset launch accounting/i,
  );
});

test("one persistent root-lineage ledger enforces depth and concurrency while tracking launches", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root-session", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });

  const leases = [];
  for (let i = 0; i < 4; i++) {
    leases.push(await reserveLineageLaunch(file, {
      id: `child-${i}`,
      parentId: null,
      name: `worker-${i}`,
      agent: "worker",
      depth: 1,
      sessionFile: `/sessions/${i}.jsonl`,
      activityFile: activityFile(file, `child-${i}`),
      ownerPid: process.pid,
      task: "bounded task",
      kind: "launch",
    }));
  }
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "child-4", parentId: null, name: "worker-4", agent: "worker", depth: 1,
      sessionFile: "/sessions/4.jsonl", activityFile: activityFile(file, "child-4"), ownerPid: process.pid,
      task: "blocked", kind: "launch",
    }),
    /concurrent descendant limit.*4/i,
  );

  await releaseLineageLaunch(file, leases[0]!.id, leases[0]!.token);
  const replacement = await reserveLineageLaunch(file, {
    id: "child-4", parentId: null, name: "worker-4", agent: "worker", depth: 1,
    sessionFile: "/sessions/4.jsonl", activityFile: activityFile(file, "child-4"), ownerPid: process.pid,
    task: "allowed after release", kind: "launch",
  });
  assert.ok(replacement.token);

  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "too-deep", parentId: "child-4", name: "grandchild", agent: "scout", depth: 3,
      sessionFile: "/sessions/deep.jsonl", activityFile: activityFile(file, "too-deep"), ownerPid: process.pid,
      task: "blocked", kind: "launch",
    }),
    /depth limit.*2/i,
  );

  const ledger = readLineageLedger(file)!;
  assert.equal(ledger.launchesUsed, 5);
  assert.equal(Object.keys(ledger.active).length, 4);
  assert.equal(ledger.lineageId, "root-session");
});

test("depth is derived from stable parent identity and cannot be reset by a child", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  const parent = await reserveLineageLaunch(file, {
    id: "parent", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "parent.jsonl", activityFile: activityFile(file, "parent"), ownerPid: process.pid,
    task: "parent", kind: "launch",
  });
  const child = await reserveLineageLaunch(file, {
    id: "child", parentId: "parent", name: "scout", agent: "scout", depth: 2,
    sessionFile: "child.jsonl", activityFile: activityFile(file, "child"), ownerPid: process.pid,
    task: "child", kind: "launch",
  });
  assert.equal(child.depth, 2);
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "spoofed", parentId: "child", name: "scout", agent: "scout", depth: 1,
      sessionFile: "spoofed.jsonl", activityFile: activityFile(file, "spoofed"), ownerPid: process.pid,
      task: "reset depth", kind: "launch",
    }),
    /depth limit.*3.*maximum 2/i,
  );
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "orphan", parentId: "not-owned", name: "scout", agent: "scout", depth: 2,
      sessionFile: "orphan.jsonl", activityFile: activityFile(file, "orphan"), ownerPid: process.pid,
      task: "orphan", kind: "launch",
    }),
    /parent not-owned is not registered/i,
  );
  await releaseLineageLaunch(file, child.id, child.token);
  await releaseLineageLaunch(file, parent.id, parent.token);
});

test("parallel reservations cannot oversubscribe the shared concurrency limit", async (t) => {
  const file = fixture(t);
  const limits = { ...DEFAULT_DELEGATION_LIMITS, maxConcurrentDescendants: 2 };
  await ensureLineageLedger(file, "root", limits, { allowLimitUpdate: true });
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    reserveLineageLaunch(file, {
      id: `parallel-${index}`, parentId: null, name: `worker-${index}`, agent: "worker", depth: 1,
      sessionFile: `${index}.jsonl`, activityFile: activityFile(file, `parallel-${index}`), ownerPid: process.pid,
      task: "parallel", kind: "launch",
    })
  ));
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 2);
  assert.equal(Object.keys(readLineageLedger(file)!.active).length, 2);
});

test("independent processes cannot oversubscribe the lineage lock", async (t) => {
  const file = fixture(t);
  const limits = { ...DEFAULT_DELEGATION_LIMITS, maxConcurrentDescendants: 2 };
  await ensureLineageLedger(file, "root", limits, { allowLimitUpdate: true });
  const moduleUrl = new URL("../pi-extension/subagents/lineage.ts", import.meta.url).href;

  const launches = Array.from({ length: 6 }, (_, index) => new Promise<{ code: number | null; output: string }>((resolveChild) => {
    const id = `process-${index}`;
    const code = `
      import { dirname, join } from "node:path";
      import { reserveLineageLaunch } from ${JSON.stringify(moduleUrl)};
      try {
        await reserveLineageLaunch(${JSON.stringify(file)}, {
          id: ${JSON.stringify(id)}, parentId: null, name: "worker", agent: "worker", depth: 1,
          sessionFile: ${JSON.stringify(`${id}.jsonl`)},
          activityFile: join(dirname(${JSON.stringify(file)}), "subagent-activity", ${JSON.stringify(`${id}.json`)}),
          ownerPid: process.pid, task: "multiprocess", kind: "launch"
        });
        process.stdout.write("reserved");
      } catch (error) {
        process.stdout.write("rejected:" + (error instanceof Error ? error.message : String(error)));
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (exitCode) => resolveChild({ code: exitCode, output }));
  }));

  const results = await Promise.all(launches);
  assert.equal(results.every((result) => result.code === 0), true, JSON.stringify(results));
  assert.equal(results.filter((result) => result.output.includes("reserved")).length, 2, JSON.stringify(results));
  const ledger = readLineageLedger(file)!;
  assert.equal(Object.keys(ledger.active).length, 2);
  assert.equal(ledger.launchesUsed, 2);
});

test("existing lock is never time-reclaimed or removed by a waiter", async (t) => {
  const file = fixture(t);
  const lockDir = `${file}.lock`;
  mkdirSync(lockDir, { recursive: true });
  const owner = { token: "replacement-owner", pid: 999999, at: 0 };
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
  await assert.rejects(
    ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true }),
    /automatic stale-lock deletion is disabled.*remove the \.lock directory manually/i,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")), owner);
});

test("resume consumes the shared launch count without changing stable descendant identity", async (t) => {
  const file = fixture(t);
  const limits = { ...DEFAULT_DELEGATION_LIMITS, maxConcurrentDescendants: 1, maxLaunchesPerLineage: 2 };
  await ensureLineageLedger(file, "root", limits, { allowLimitUpdate: true });

  const first = await reserveLineageLaunch(file, {
    id: "stable-id", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "worker.jsonl", activityFile: activityFile(file, "stable-id"), ownerPid: process.pid,
    task: "first", kind: "launch",
  });
  await releaseLineageLaunch(file, first.id, first.token);
  const resumed = await reserveLineageLaunch(file, {
    id: "stable-id", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "worker.jsonl", activityFile: activityFile(file, "stable-id"), ownerPid: process.pid,
    task: "follow up", kind: "resume",
  });
  assert.equal(resumed.id, "stable-id");
  await releaseLineageLaunch(file, resumed.id, resumed.token);

  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "another", parentId: null, name: "scout", agent: "scout", depth: 1,
      sessionFile: "scout.jsonl", activityFile: activityFile(file, "another"), ownerPid: process.pid,
      task: "third", kind: "launch",
    }),
    /launch limit.*2.*new root session or explicitly change/i,
  );
  assert.equal(readLineageLedger(file)!.launchesUsed, 2);
});

test("failed pre-spawn rollback refunds only its reservation and stale tokens cannot release a retry", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root", { ...DEFAULT_DELEGATION_LIMITS, maxConcurrentDescendants: 1 }, { allowLimitUpdate: true });
  const failed = await reserveLineageLaunch(file, {
    id: "same", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "worker.jsonl", activityFile: activityFile(file, "same"), ownerPid: process.pid,
    task: "attempt", kind: "launch",
  });
  await releaseLineageLaunch(file, failed.id, failed.token, { refundLaunch: true });
  assert.equal(readLineageLedger(file)!.launchesUsed, 0);

  const retry = await reserveLineageLaunch(file, {
    id: "same", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "worker.jsonl", activityFile: activityFile(file, "same"), ownerPid: process.pid,
    task: "retry", kind: "launch",
  });
  await releaseLineageLaunch(file, retry.id, failed.token);
  assert.equal(Object.keys(readLineageLedger(file)!.active).length, 1);
  await touchLineageLaunch(file, retry.id, retry.token, 12345);
  assert.equal(readLineageLedger(file)!.active.same!.heartbeatAt, 12345);
  assert.equal(await setLineageLaunchOwner(file, retry.id, retry.token, 54321, 12346), true);
  assert.equal(readLineageLedger(file)!.active.same!.ownerPid, 54321);
  assert.equal(await setLineageLaunchOwner(file, retry.id, "stale-token", 99999), false);
  assert.equal(readLineageLedger(file)!.active.same!.ownerPid, 54321);
  await releaseLineageLaunch(file, retry.id, retry.token);
  assert.equal(Object.keys(readLineageLedger(file)!.active).length, 0);
});

test("abandoned active records are reclaimed without resetting launch usage", async (t) => {
  const file = fixture(t);
  const limits = { ...DEFAULT_DELEGATION_LIMITS, maxConcurrentDescendants: 1 };
  await ensureLineageLedger(file, "root", limits, { allowLimitUpdate: true });
  await reserveLineageLaunch(file, {
    id: "stale", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "stale.jsonl", activityFile: activityFile(file, "stale"), ownerPid: 2_000_000_000,
    task: "stale task", kind: "launch",
  });
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.active.stale.heartbeatAt = 0;
  writeFileSync(file, JSON.stringify(raw));

  assert.equal(await reconcileLineageLedger(file), true);
  assert.equal(Object.keys(readLineageLedger(file)!.active).length, 0);
  assert.equal(readLineageLedger(file)!.launchesUsed, 1);

  const replacement = await reserveLineageLaunch(file, {
    id: "fresh", parentId: null, name: "scout", agent: "scout", depth: 1,
    sessionFile: "fresh.jsonl", activityFile: activityFile(file, "fresh"), ownerPid: process.pid,
    task: "fresh task", kind: "launch",
  });
  assert.equal(readLineageLedger(file)!.launchesUsed, 2);
  assert.deepEqual(Object.keys(readLineageLedger(file)!.active), ["fresh"]);
  await releaseLineageLaunch(file, replacement.id, replacement.token);
});

test("corrupt persisted accounting fails closed instead of silently resetting", async (t) => {
  const file = fixture(t);
  writeFileSync(file, "{not-json");
  await assert.rejects(
    ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true }),
    /invalid.*refusing to reset launch accounting/i,
  );
});

test("normal root initialization migrates a legacy finite ledger to the unlimited default without resetting state", async (t) => {
  const file = fixture(t);
  const legacyLimits = { maxDepth: 2, maxConcurrentDescendants: 4, maxLaunchesPerLineage: 12 };
  await ensureLineageLedger(file, "root", legacyLimits, { allowLimitUpdate: true });
  const lease = await reserveLineageLaunch(file, {
    id: "a", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "a.jsonl", activityFile: activityFile(file, "a"), ownerPid: process.pid,
    task: "task", kind: "launch",
  });

  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  const ledger = readLineageLedger(file)!;
  assert.equal(ledger.launchesUsed, 1);
  assert.equal(ledger.limits.maxLaunchesPerLineage, null);
  assert.equal(ledger.descendants.a!.launches, 1);
  assert.equal(ledger.active.a!.token, lease.token);
});

test("inherited children cannot loosen an explicitly finite root policy", async (t) => {
  const file = fixture(t);
  const finiteLimits = { maxDepth: 2, maxConcurrentDescendants: 1, maxLaunchesPerLineage: 1 };
  await ensureLineageLedger(file, "root", finiteLimits, { allowLimitUpdate: true });
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: false });
  assert.deepEqual(readLineageLedger(file)!.limits, finiteLimits);

  const lease = await reserveLineageLaunch(file, {
    id: "a", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "a.jsonl", activityFile: activityFile(file, "a"), ownerPid: process.pid,
    task: "task", kind: "launch",
  });
  await releaseLineageLaunch(file, lease.id, lease.token);
  await assert.rejects(
    reserveLineageLaunch(file, {
      id: "b", parentId: null, name: "worker", agent: "worker", depth: 1,
      sessionFile: "b.jsonl", activityFile: activityFile(file, "b"), ownerPid: process.pid,
      task: "blocked", kind: "launch",
    }),
    /launch limit reached \(1 launch/i,
  );
});

test("existing lineage keeps launch usage when root explicitly changes finite limits", async (t) => {
  const file = fixture(t);
  await ensureLineageLedger(file, "root", DEFAULT_DELEGATION_LIMITS, { allowLimitUpdate: true });
  const lease = await reserveLineageLaunch(file, {
    id: "a", parentId: null, name: "worker", agent: "worker", depth: 1,
    sessionFile: "a.jsonl", activityFile: activityFile(file, "a"), ownerPid: process.pid,
    task: "task", kind: "launch",
  });
  await releaseLineageLaunch(file, lease.id, lease.token);

  await ensureLineageLedger(file, "root", { maxDepth: 3, maxConcurrentDescendants: 5, maxLaunchesPerLineage: 20 }, { allowLimitUpdate: true });
  const ledger = readLineageLedger(file)!;
  assert.equal(ledger.launchesUsed, 1);
  assert.equal(ledger.limits.maxLaunchesPerLineage, 20);
});
