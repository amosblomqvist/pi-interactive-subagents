import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const OWNER_LABEL = "pi.subagent.surface";
const STATUS_INTERVAL = 250;

type Metadata = { state: "live" | "finished"; pid?: number; exitCode?: number };
type Target = { space: string; tab: string };
export type HerdrSurface = {
  owner: string;
  name: string;
  parent: string;
  target: Target;
  cwd: string;
  address?: string;
  removed?: boolean;
  checkedAt?: number;
  metadata?: Metadata;
};

class HerdrCommandError extends Error {
  status?: number;
  constructor(command: string, status?: number) {
    super(`Herdr ${command} failed${status === undefined ? "" : ` (exit ${status})`}`);
    this.status = status;
  }
}

function command(binary: "hc" | "herdr-app", args: string[]): string {
  try {
    return execFileSync(binary, args, { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    // CLI output may contain terminal screens and argv, including private data.
    throw new HerdrCommandError(`${binary} ${args[0]}`, typeof error.status === "number" ? error.status : undefined);
  }
}
function json(binary: "hc" | "herdr-app", args: string[]): any {
  const output = command(binary, args);
  try { return JSON.parse(output); }
  catch { throw new Error(`Herdr ${binary} ${args[0]} returned invalid JSON`); }
}
function localAddress(value: unknown): value is string {
  return typeof value === "string" && /^t[0-9a-z]+$/.test(value);
}
function spaces(): any[] {
  const tree = json("herdr-app", ["ls"]);
  const result = Array.isArray(tree) ? tree : tree?.spaces;
  if (!Array.isArray(result)) throw new Error("Herdr app returned invalid spaces metadata");
  return result;
}
function locations(tree: any[]): { target: Target; space: any; terminals: any[] }[] {
  return tree.flatMap(space => (Array.isArray(space.tabs) ? space.tabs : []).map((tab: any) => ({
    target: { space: space.id, tab: tab.id }, space, terminals: Array.isArray(tab.terminals) ? tab.terminals : [],
  })));
}
function hasCaller(term: any, parent: string): boolean {
  return term.terminal === parent || (Array.isArray(term.sub_agents) && term.sub_agents.some((child: any) =>
    child === parent || child?.terminal === parent || child?.address === parent));
}
function validateParent(parent: string): void {
  let data: any;
  try { data = json("hc", ["get", parent]); }
  catch { throw new Error("Herdr parent terminal could not be validated with hc get"); }
  if (data.address !== parent || data.state !== "live") throw new Error("Herdr parent terminal is not live");
}
export function createHerdrSurface(name: string): HerdrSurface {
  const parent = process.env.HC_TERMINAL_ID;
  if (!localAddress(parent)) throw new Error("Herdr requires a local HC_TERMINAL_ID parent terminal");
  validateParent(parent);
  const all = locations(spaces());
  const callers = all.filter(item => item.terminals.some(term => hasCaller(term, parent)));
  if (callers.length !== 1) throw new Error("Herdr parent must belong to exactly one existing app tab");
  const override = process.env.PI_SUBAGENT_HERDR_TAB;
  const matches = override === undefined ? callers : all.filter(item => item.target.tab === override);
  if (matches.length !== 1) throw new Error("Herdr target tab does not exist or is ambiguous");
  const chosen = matches[0];
  if (chosen.space.machine || callers[0].space.machine) throw new Error("Herdr surface supports local spaces only, not remote targets");
  if (typeof chosen.target.space !== "string" || typeof chosen.target.tab !== "string") throw new Error("Herdr target IDs are invalid");
  return { owner: randomUUID(), name, parent, target: chosen.target, cwd: process.cwd() };
}
function owned(state: HerdrSurface, data: any): Metadata {
  if (data.address !== state.address || data.labels?.[OWNER_LABEL] !== state.owner || data.parent !== state.parent) {
    throw new Error("Herdr terminal ownership mismatch; refusing access");
  }
  if (data.state !== "live" && data.state !== "finished") throw new Error("Herdr terminal returned invalid state metadata");
  return {
    state: data.state,
    pid: Number.isInteger(data.pid) && data.pid > 0 ? data.pid : undefined,
    exitCode: data.state === "finished" ? (Number.isInteger(data.exit_code) ? data.exit_code : 1) : undefined,
  };
}
export function herdrMetadata(state: HerdrSurface, force = false): Metadata {
  if (state.removed || !state.address) throw new Error("Herdr terminal is closed or has not launched");
  if (!force && state.metadata && Date.now() - (state.checkedAt ?? 0) < STATUS_INTERVAL) return state.metadata;
  const metadata = owned(state, json("hc", ["get", state.address]));
  state.metadata = metadata;
  state.checkedAt = Date.now();
  return metadata;
}
export function closeHerdrSurface(state: HerdrSurface): void {
  if (state.removed || !state.address) return;
  try {
    const metadata = herdrMetadata(state, true);
    if (metadata.state === "live") {
      try { command("hc", ["kill", state.address]); }
      catch (error) { if (!(error instanceof HerdrCommandError) || (error.status !== 11 && error.status !== 3)) throw error; }
    }
    // Revalidate ownership after kill, before removing the retained terminal.
    herdrMetadata(state, true);
    command("hc", ["rm", state.address]);
  } catch (error) {
    if (!(error instanceof HerdrCommandError) || error.status !== 3) throw error;
  }
  state.removed = true;
}
export function launchHerdrSurface(state: HerdrSurface, bash: string, script: string, mailbox?: string): void {
  if (state.address || state.removed) throw new Error("Herdr surface cannot be launched twice");
  validateParent(state.parent);
  const target = locations(spaces()).find(item => item.target.space === state.target.space && item.target.tab === state.target.tab);
  if (!target || target.space.machine) throw new Error("Herdr local target tab no longer exists");
  const args = ["run", "--bg", "--json", "--no-notify", "--parent", state.parent, "--cwd", state.cwd,
    "--label", `herdr.space=${state.target.space}`, "--label", `herdr.tab=${state.target.tab}`,
    "--label", `${OWNER_LABEL}=${state.owner}`, "--label", `pi.subagent.name=${state.name}`,
    "--", "env", "-u", "PI_SUBAGENT_HERDR_TAB", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
    "PI_SUBAGENT_SURFACE_BACKEND=herdr", ...(mailbox ? [`PI_SUBAGENT_IPC_DIR=${mailbox}`] : []), bash, script];
  try {
    const result = json("hc", args);
    if (!localAddress(result.address)) throw new Error("Herdr launch returned an invalid local terminal address");
    state.address = result.address;
    herdrMetadata(state, true);
    state.checkedAt = 0;
  } catch (error) {
    try {
      // A failed CLI reply can still have created a terminal. Never retry run.
      const result = json("hc", ["ls", "--all", "--json"]);
      const terminals = Array.isArray(result) ? result : result?.terminals;
      if (!Array.isArray(terminals)) throw new Error("Herdr terminal list returned invalid metadata");
      const candidates = terminals.filter((item: any) => localAddress(item.address) && item.labels?.[OWNER_LABEL] === state.owner && item.parent === state.parent);
      if (Array.isArray(candidates) && candidates.length === 1) {
        state.address = candidates[0].address;
        closeHerdrSurface(state);
      } else if (state.address) closeHerdrSurface(state);
    } catch { throw new Error("Herdr launch failed; owned terminal cleanup could not be confirmed (no retry)"); }
    throw error;
  }
}
export async function waitHerdrAdoption(state: HerdrSurface, deadline: number): Promise<void> {
  for (;;) {
    if (herdrMetadata(state).state === "finished") throw new Error("Herdr terminal closed before pane adoption");
    const target = locations(spaces()).find(item => item.target.space === state.target.space && item.target.tab === state.target.tab);
    if (target?.terminals.some(term => term.terminal === state.address && typeof term.pane === "string" && term.pane)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Herdr pane adoption timed out in target tab");
    await new Promise(resolve => setTimeout(resolve, Math.min(STATUS_INTERVAL, remaining)));
  }
}
export function readHerdrScreen(state: HerdrSurface): string {
  herdrMetadata(state, true);
  return command("hc", ["read", "--lines", "0", state.address!]);
}
