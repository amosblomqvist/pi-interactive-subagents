import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateResumeConstraints, writeTerminalReceipt, readTerminalReceipt, clearTerminalReceipt } from "../pi-extension/subagents/project-session-contract.ts";

test("resume constraints fail closed for missing cwd, changed symlink and wrong profile", () => {
  const root = mkdtempSync(join(tmpdir(), "resume-contract-"));
  try {
    const cwd = join(root, "project"); const other = join(root, "other"); const alias = join(root, "alias");
    mkdirSync(cwd); mkdirSync(other); symlinkSync(cwd, alias);
    const saved = { agent: "project-worker", cwd };
    validateResumeConstraints(saved, { expected_cwd: alias, expected_agent: "project-worker" });
    assert.throws(() => validateResumeConstraints(saved, { expected_agent: "worker" }), /agent/i);
    assert.throws(() => validateResumeConstraints({ ...saved, cwd: null }, { expected_cwd: cwd }), /cwd/i);
    unlinkSync(alias); symlinkSync(other, alias);
    assert.throws(() => validateResumeConstraints(saved, { expected_cwd: alias }), /cwd/i);
    rmSync(cwd, { recursive: true });
    assert.throws(() => validateResumeConstraints(saved, { expected_cwd: cwd }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal receipt is bounded, identity checked, and invalidated before another run", () => {
  const root = mkdtempSync(join(tmpdir(), "receipt-contract-"));
  const sessionFile = join(root, "child.jsonl");
  const identity = { id: "lease", name: "project", agent: "project-worker", cwd: root, sessionFile };
  try {
    assert.equal(readTerminalReceipt(identity), null);
    writeTerminalReceipt({ ...identity, status: "finished", result: "x".repeat(100000), exitCode: 0 });
    const receipt = readTerminalReceipt(identity)!;
    assert.equal(receipt.status, "finished"); assert.ok(receipt.result!.length < 51000);
    assert.equal(readTerminalReceipt({ ...identity, id: "other" }), null);
    clearTerminalReceipt(sessionFile);
    assert.equal(readTerminalReceipt(identity), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
