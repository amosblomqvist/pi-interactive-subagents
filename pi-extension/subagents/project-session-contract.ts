import { closeSync, fstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface ChildStatus {
  id: string;
  name: string;
  agent: string | null;
  cwd: string | null;
  sessionFile: string;
  status: "running" | "finished" | "unknown";
  result?: string;
  exitCode?: number;
}

export function validateResumeConstraints(
  saved: { agent: string | null; cwd: string | null },
  expected: { expected_agent?: string; expected_cwd?: string },
): void {
  if (expected.expected_agent !== undefined && saved.agent !== expected.expected_agent) {
    throw new Error("Cannot resume: saved agent does not match expected_agent");
  }
  if (expected.expected_cwd !== undefined) {
    if (!saved.cwd || realpathSync(saved.cwd) !== realpathSync(expected.expected_cwd)) {
      throw new Error("Cannot resume: saved cwd does not match expected_cwd");
    }
  }
}

export function clearTerminalReceipt(sessionFile: string): void {
  rmSync(`${sessionFile}.result.json`, { force: true });
}

export function writeTerminalReceipt(receipt: ChildStatus): void {
  const path = `${receipt.sessionFile}.result.json`;
  const tmp = `${path}.tmp-${randomUUID()}`;
  const result = receipt.result && receipt.result.length > 48000
    ? receipt.result.slice(0, 48000) + "\n[Result truncated]" : receipt.result;
  try {
    writeFileSync(tmp, JSON.stringify({ ...receipt, result }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

export function readTerminalReceipt(identity: Omit<ChildStatus, "status">): ChildStatus | null {
  let fd: number | undefined;
  try {
    fd = openSync(`${identity.sessionFile}.result.json`, "r");
    const size = fstatSync(fd).size;
    if (size < 1 || size > 300000) return null;
    const buffer = Buffer.alloc(size);
    const bytes = readSync(fd, buffer, 0, size, 0);
    const value = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    if (["id", "name", "agent", "cwd", "sessionFile"].some(key => value[key] !== identity[key as keyof typeof identity])) return null;
    if (value.status !== "finished" || typeof value.result !== "string" || value.result.length > 48100 || !Number.isInteger(value.exitCode)) return null;
    return { ...identity, status: "finished", result: value.result, exitCode: value.exitCode };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
