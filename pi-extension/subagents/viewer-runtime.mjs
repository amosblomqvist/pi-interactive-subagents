#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_SNAPSHOT_BYTES = 32 * 1024;

const snapshotFile = process.argv[2];
if (!snapshotFile || process.argv.length !== 3) {
  process.stderr.write("Usage: viewer-runtime.mjs <owned-snapshot.json>\n");
  process.exit(2);
}

function clean(value, limit = 240) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(authorization\s*:\s*bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret)(\s*[:=]\s*)([^\s,;&]+)/gi, "$1$2[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[token redacted]")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, "[credential redacted]")
    .trim()
    .slice(0, limit);
}

function readSnapshot() {
  const fd = openSync(snapshotFile, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 1 || size > MAX_SNAPSHOT_BYTES) throw new Error("snapshot is outside the size bound");
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(fd, buffer, 0, size, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function render() {
  let snapshot;
  try {
    snapshot = readSnapshot();
  } catch {
    snapshot = null;
  }
  const lines = ["Read-only subagent viewer", ""];
  if (!snapshot || snapshot.version !== 1) {
    lines.push("Waiting for a valid owned snapshot…");
  } else {
    lines.push(`${clean(snapshot.name, 100)} [${clean(snapshot.id, 100)}]`);
    lines.push(`role: ${clean(snapshot.agent ?? "(none)", 100)} · depth: ${Number(snapshot.depth) || 0}`);
    lines.push(`status: ${clean(snapshot.status, 120)} · elapsed: ${clean(snapshot.elapsed, 40)}`);
    lines.push("", "Observable events (thinking/reasoning excluded):");
    const events = Array.isArray(snapshot.events) ? snapshot.events.slice(-20) : [];
    if (events.length === 0) lines.push("  No persisted events yet.");
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      lines.push(`  ${clean(event.kind, 20)} · ${clean(event.text, 240)}`);
    }
  }
  lines.push("", "This viewer cannot send input to Pi or invoke a model. Ctrl+C exits.");
  process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
}

render();
const timer = setInterval(render, 750);
function stop() {
  clearInterval(timer);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
