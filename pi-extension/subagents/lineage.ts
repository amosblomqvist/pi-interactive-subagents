import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { sanitizeMonitorText } from "./monitor.ts";

export interface DelegationLimits {
  maxDepth: number;
  maxConcurrentDescendants: number;
  maxLaunchesPerLineage: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
  maxDepth: 2,
  maxConcurrentDescendants: 4,
  maxLaunchesPerLineage: 12,
};

export type LineageLaunchKind = "launch" | "resume";

export interface LineageDescendantRecord {
  id: string;
  parentId: string | null;
  name: string;
  agent: string | null;
  depth: number;
  sessionFile: string;
  activityFile: string;
  task: string;
  firstLaunchedAt: number;
  lastLaunchedAt: number;
  launches: number;
}

export interface ActiveLineageRecord extends LineageDescendantRecord {
  token: string;
  ownerPid: number;
  heartbeatAt: number;
  kind: LineageLaunchKind;
}

export interface LineageLedger {
  version: 1;
  lineageId: string;
  createdAt: number;
  updatedAt: number;
  limits: DelegationLimits;
  launchesUsed: number;
  descendants: Record<string, LineageDescendantRecord>;
  active: Record<string, ActiveLineageRecord>;
}

export interface LineageLaunchRequest {
  id: string;
  parentId: string | null;
  name: string;
  agent: string | null;
  depth: number;
  sessionFile: string;
  activityFile: string;
  ownerPid: number;
  task: string;
  kind: LineageLaunchKind;
}

export interface LineageLease {
  id: string;
  token: string;
  lineageId: string;
  depth: number;
  limits: DelegationLimits;
  launchesUsed: number;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const ABANDONED_ACTIVE_MS = 15_000;
const MAX_RECORDS = 10_000;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 32_768;

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function validLimit(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RECORDS;
}

export function validateDelegationLimits(value: unknown): DelegationLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delegation limits must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = ["maxDepth", "maxConcurrentDescendants", "maxLaunchesPerLineage"];
  const extra = Object.keys(input).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`delegation limits have unsupported key(s): ${extra.join(", ")}`);
  for (const key of keys) {
    if (!validLimit(input[key])) throw new Error(`delegation.${key} must be an integer from 0 to ${MAX_RECORDS}`);
  }
  return {
    maxDepth: input.maxDepth as number,
    maxConcurrentDescendants: input.maxConcurrentDescendants as number,
    maxLaunchesPerLineage: input.maxLaunchesPerLineage as number,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDescendant(value: unknown, id: string, active: boolean): boolean {
  const record = asObject(value);
  if (!record || !boundedString(id, MAX_ID_LENGTH) || record.id !== id) return false;
  if (record.parentId !== null && !boundedString(record.parentId, MAX_ID_LENGTH)) return false;
  if (!boundedString(record.name, 100) || !boundedString(record.task, 300)) return false;
  if (!boundedString(record.sessionFile, MAX_PATH_LENGTH) || !boundedString(record.activityFile, MAX_PATH_LENGTH)) return false;
  if (record.agent !== null && !boundedString(record.agent, 100)) return false;
  if (!validLimit(record.depth) || !validLimit(record.launches)) return false;
  if (!Number.isFinite(record.firstLaunchedAt) || !Number.isFinite(record.lastLaunchedAt)) return false;
  if (!active) return true;
  return boundedString(record.token, 128) && record.token.length > 0 &&
    Number.isInteger(record.ownerPid) && (record.ownerPid as number) > 0 &&
    Number.isFinite(record.heartbeatAt) &&
    (record.kind === "launch" || record.kind === "resume");
}

function normalizeLedger(value: unknown): LineageLedger | null {
  const input = asObject(value);
  if (!input || input.version !== 1 || typeof input.lineageId !== "string") return null;
  let limits: DelegationLimits;
  try {
    limits = validateDelegationLimits(input.limits);
  } catch {
    return null;
  }
  if (!validLimit(input.launchesUsed) || !Number.isFinite(input.createdAt) || !Number.isFinite(input.updatedAt)) return null;
  const descendants = asObject(input.descendants);
  const active = asObject(input.active);
  if (!descendants || !active) return null;
  if (Object.keys(descendants).length > MAX_RECORDS || Object.keys(active).length > MAX_RECORDS) return null;
  for (const [id, record] of Object.entries(descendants)) if (!validDescendant(record, id, false)) return null;
  for (const [id, record] of Object.entries(active)) if (!validDescendant(record, id, true)) return null;
  return { ...input, limits, descendants, active } as unknown as LineageLedger;
}

export function readLineageLedger(file: string): LineageLedger | null {
  try {
    if (!existsSync(file) || statSync(file).size > MAX_LEDGER_BYTES) return null;
    return normalizeLedger(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function writeLedger(file: string, ledger: LineageLedger): void {
  mkdirSync(dirname(file), { recursive: true });
  const payload = `${JSON.stringify(ledger, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_LEDGER_BYTES) {
    throw new Error(`Subagent lineage ledger exceeds its ${MAX_LEDGER_BYTES}-byte bound`);
  }
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, payload, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockDir: string, now: number): boolean {
  try {
    return now - statSync(lockDir).mtimeMs >= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLock(file: string): Promise<() => void> {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(dirname(file), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(`${lockDir}/owner.json`, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(lockDir, Date.now())) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring subagent lineage lock: ${file}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

async function withLedger<T>(file: string, mutate: (ledger: LineageLedger | null) => T): Promise<T> {
  const release = await acquireLock(file);
  try {
    return mutate(readLineageLedger(file));
  } finally {
    release();
  }
}

function newLedger(lineageId: string, limits: DelegationLimits, now: number): LineageLedger {
  return {
    version: 1,
    lineageId,
    createdAt: now,
    updatedAt: now,
    limits: { ...limits },
    launchesUsed: 0,
    descendants: {},
    active: {},
  };
}

export async function ensureLineageLedger(
  file: string,
  lineageId: string,
  limits: DelegationLimits,
  options: { allowLimitUpdate: boolean },
): Promise<LineageLedger> {
  const validated = validateDelegationLimits(limits);
  return withLedger(file, (existing) => {
    const now = Date.now();
    if (!existing && existsSync(file)) {
      throw new Error(`Subagent lineage ledger is invalid; refusing to reset launch accounting: ${file}`);
    }
    if (existing && existing.lineageId !== lineageId) {
      throw new Error(`Subagent lineage file belongs to ${existing.lineageId}, not ${lineageId}`);
    }
    const ledger = existing ?? newLedger(lineageId, validated, now);
    if (existing && options.allowLimitUpdate) ledger.limits = { ...validated };
    ledger.updatedAt = now;
    writeLedger(file, ledger);
    return ledger;
  });
}

function reconcileAbandoned(ledger: LineageLedger, now: number): boolean {
  let changed = false;
  for (const [id, record] of Object.entries(ledger.active)) {
    if (now - record.heartbeatAt < ABANDONED_ACTIVE_MS) continue;
    if (processAlive(record.ownerPid)) continue;
    delete ledger.active[id];
    changed = true;
  }
  return changed;
}

/** Reap dead process leases even when no later launch attempts another reservation. */
export async function reconcileLineageLedger(file: string, now = Date.now()): Promise<boolean> {
  return withLedger(file, (ledger) => {
    if (!ledger) return false;
    const changed = reconcileAbandoned(ledger, now);
    if (changed) {
      ledger.updatedAt = now;
      writeLedger(file, ledger);
    }
    return changed;
  });
}

export async function reserveLineageLaunch(
  file: string,
  request: LineageLaunchRequest,
): Promise<LineageLease> {
  if (!boundedString(request.id, MAX_ID_LENGTH) || !request.id) throw new Error("Subagent lineage id is invalid or too long");
  if (request.parentId !== null && !boundedString(request.parentId, MAX_ID_LENGTH)) throw new Error("Subagent lineage parent id is invalid or too long");
  if (!boundedString(request.sessionFile, MAX_PATH_LENGTH) || !boundedString(request.activityFile, MAX_PATH_LENGTH)) {
    throw new Error("Subagent lineage artifact path is invalid or too long");
  }
  if (!validLimit(request.depth)) throw new Error("Subagent lineage depth is invalid");
  if (!Number.isSafeInteger(request.ownerPid) || request.ownerPid <= 0) throw new Error("Subagent lineage owner process is invalid");
  return withLedger(file, (ledger) => {
    if (!ledger) throw new Error(`Subagent lineage ledger is missing or invalid: ${file}`);
    const now = Date.now();
    reconcileAbandoned(ledger, now);
    const existingDescendant = ledger.descendants[request.id];
    if (existingDescendant && existingDescendant.parentId !== request.parentId) {
      throw new Error(`Subagent ${request.id} cannot change its stable lineage parent.`);
    }
    const parentId = existingDescendant?.parentId ?? request.parentId;
    const parent = parentId ? ledger.descendants[parentId] : null;
    if (parentId && !parent) {
      throw new Error(`Subagent lineage parent ${parentId} is not registered in this root lineage.`);
    }
    const depth = existingDescendant?.depth ?? (parent ? parent.depth + 1 : 1);
    if (depth > ledger.limits.maxDepth || request.depth > ledger.limits.maxDepth) {
      throw new Error(
        `Subagent depth limit reached: requested depth ${Math.max(depth, request.depth)}, configured maximum ${ledger.limits.maxDepth} (root=0).`,
      );
    }
    if (request.depth !== depth) {
      throw new Error(`Subagent lineage depth mismatch: requested ${request.depth}, expected stable depth ${depth}.`);
    }
    if (ledger.active[request.id]) {
      throw new Error(`Subagent ${request.id} already has an active launch in this lineage.`);
    }
    const activeCount = Object.keys(ledger.active).length;
    if (activeCount >= ledger.limits.maxConcurrentDescendants) {
      throw new Error(
        `Subagent concurrent descendant limit reached (${ledger.limits.maxConcurrentDescendants} active across this root lineage). ` +
        "Wait for or cancel an active descendant before launching another.",
      );
    }
    if (ledger.launchesUsed >= ledger.limits.maxLaunchesPerLineage) {
      throw new Error(
        `Subagent launch limit reached (${ledger.limits.maxLaunchesPerLineage} launches for this root-session lineage). ` +
        "Launches, including resumes, are an operational count, not a dollar budget. Start a new root session or explicitly change the delegation configuration; the count is never reset automatically.",
      );
    }

    const token = randomBytes(16).toString("hex");
    const previousLaunches = existingDescendant?.launches ?? 0;
    const descendant: LineageDescendantRecord = {
      id: request.id,
      parentId,
      name: sanitizeMonitorText(request.name, 100) || request.id,
      agent: request.agent ? sanitizeMonitorText(request.agent, 100) : null,
      depth,
      sessionFile: request.sessionFile,
      activityFile: request.activityFile,
      task: sanitizeMonitorText(request.task, 300),
      firstLaunchedAt: existingDescendant?.firstLaunchedAt ?? now,
      lastLaunchedAt: now,
      launches: previousLaunches + 1,
    };
    const active: ActiveLineageRecord = {
      ...descendant,
      token,
      ownerPid: request.ownerPid,
      heartbeatAt: now,
      kind: request.kind,
    };
    ledger.descendants[request.id] = descendant;
    ledger.active[request.id] = active;
    ledger.launchesUsed += 1;
    ledger.updatedAt = now;
    writeLedger(file, ledger);
    return {
      id: request.id,
      token,
      lineageId: ledger.lineageId,
      depth,
      limits: { ...ledger.limits },
      launchesUsed: ledger.launchesUsed,
    };
  });
}

export async function touchLineageLaunch(
  file: string,
  id: string,
  token: string,
  heartbeatAt = Date.now(),
): Promise<boolean> {
  return withLedger(file, (ledger) => {
    const record = ledger?.active[id];
    if (!ledger || !record || record.token !== token) return false;
    record.heartbeatAt = heartbeatAt;
    ledger.updatedAt = heartbeatAt;
    writeLedger(file, ledger);
    return true;
  });
}

/** Move liveness ownership from the launcher to the spawned process. */
export async function setLineageLaunchOwner(
  file: string,
  id: string,
  token: string,
  ownerPid: number,
  heartbeatAt = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  return withLedger(file, (ledger) => {
    const record = ledger?.active[id];
    if (!ledger || !record || record.token !== token) return false;
    record.ownerPid = ownerPid;
    record.heartbeatAt = heartbeatAt;
    ledger.updatedAt = heartbeatAt;
    writeLedger(file, ledger);
    return true;
  });
}

export async function releaseLineageLaunch(
  file: string,
  id: string,
  token: string,
  options: { refundLaunch?: boolean } = {},
): Promise<boolean> {
  return withLedger(file, (ledger) => {
    const record = ledger?.active[id];
    if (!ledger || !record || record.token !== token) return false;
    delete ledger.active[id];
    if (options.refundLaunch) {
      ledger.launchesUsed = Math.max(0, ledger.launchesUsed - 1);
      const descendant = ledger.descendants[id];
      if (descendant) {
        descendant.launches = Math.max(0, descendant.launches - 1);
        if (descendant.launches === 0) delete ledger.descendants[id];
      }
    }
    ledger.updatedAt = Date.now();
    writeLedger(file, ledger);
    return true;
  });
}
