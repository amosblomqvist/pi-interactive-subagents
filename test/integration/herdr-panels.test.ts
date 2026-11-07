import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import * as surface from "../../pi-extension/subagents/surface.ts";

const cli = process.env.PI_TEST_CLI;
const enabled = process.env.PI_TEST_HERDR === "1" && !!cli;
function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
}
function app(command: string, args: object) {
  const result = JSON.parse(run("herdr-app", ["do", command, JSON.stringify(args)]));
  assert.ok(!result.error, JSON.stringify(result));
  return result;
}
function findTab(tree: any, id: string): any {
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.id === id && Array.isArray(tree.terminals)) return tree;
  for (const value of Object.values(tree)) {
    const found = findTab(value, id);
    if (found) return found;
  }
}
async function until(check: () => boolean, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < deadline, label); await delay(50); }
}

test("authorized Herdr app: two native Pi panels, steering, keyboard input and isolated cancellation", { skip: !enabled, timeout: 90000 }, async () => {
  assert.equal(typeof surface.getSurfaceTerminalAddress, "function", "native Herdr surface address API is required");
  const root = mkdtempSync(join(tmpdir(), "pi-herdr-e2e-"));
  const original = JSON.parse(run("herdr-app", ["status"]));
  const savedEnv = { ...process.env };
  const appHome = process.env.HERDR_APP_HOME || join(process.env.HOME!, ".config/herdr-app");
  const protectedPaths = ["settings.json", "keys.json", `layouts/${original.layout}.json`].map(p => join(appHome, p)).filter(existsSync);
  const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const hashes = protectedPaths.map(hash);
  const surfaces: string[] = [];
  const terminals: string[] = [];
  let tab: any;
  try {
    tab = app("tab.new", { name: "PRUEBA TEMPORAL — dos Pi interactivos", space: original.space, folder: root,
      argv: [process.execPath, "-e", "console.log('ANCLA TEMPORAL DE PRUEBA');process.stdin.resume()"] });
    process.env.PI_SUBAGENT_SURFACE_BACKEND = "herdr";
    process.env.PI_SUBAGENT_HERDR_TAB = tab.tab;
    process.env.HC_TERMINAL_ID = tab.terminal;
    const records = ["EXPLORADOR", "REVISOR"].map(role => {
      const dir = join(root, role); mkdirSync(dir); mkdirSync(join(dir, "home")); mkdirSync(join(dir, "agent"));
      const handle = surface.createSurface(role); surfaces.push(handle);
      const session = join(dir, "session.jsonl");
      const env = {
        HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"),
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TERM: "xterm-256color", TERM_PROGRAM: "herdr", PI_OFFLINE: "1",
        PI_SUBAGENT_AUTO_EXIT: "0", PI_SUBAGENT_SESSION: session, PI_SUBAGENT_NAME: role,
        PI_TEST_FAUX: resolve(dirname(cli!), "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js"),
        PI_TEST_PANEL_DIR: dir, PI_TEST_PANEL_ROLE: role,
      };
      const args = [process.execPath, cli!, "--session", session, "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--tools", "read",
        "-e", resolve("pi-extension/subagents/subagent-done.ts"), "-e", resolve("test/integration/fixtures/herdr-panels.ts"), "--model", "herdr-faux/local"];
      const command = `cd ${surface.shellEscape(dir)} && env -i PI_SUBAGENT_IPC_DIR="$PI_SUBAGENT_IPC_DIR" HC_TERMINAL_ID="$HC_TERMINAL_ID" HC_TERMINAL_SOCKET="$HC_TERMINAL_SOCKET" HC_SCOPE="$HC_SCOPE" ${Object.entries(env).map(([k,v]) => `${k}=${surface.shellEscape(v)}`).join(" ")} ${args.map(surface.shellEscape).join(" ")}`;
      surface.sendLongCommand(handle, command, { scriptPath: join(dir, "launch.sh"), interactive: { messages: [{ message: `${role}: prueba local. Espera la señal de la fixture.`, deliverAs: "followUp" }] } });
      const terminal = surface.getSurfaceTerminalAddress(handle)!;
      assert.ok(terminal, "a native core terminal must exist"); terminals.push(terminal);
      return { dir, handle, terminal, session };
    });
    assert.notEqual(terminals[0], terminals[1]);
    await Promise.all(records.map(r => surface.waitSurfaceReady(r.handle, { sessionFile: r.session })));
    await until(() => records.every(r => existsSync(join(r.dir, "working"))), "both local providers must be active");
    for (const record of records) {
      assert.deepEqual(JSON.parse(readFileSync(join(record.dir, "mode"), "utf8")), { mode: "tui", stdin: true, stdout: true });
      const state = JSON.parse(run("hc", ["get", record.terminal, "--json"]));
      assert.equal(state.parent, tab.terminal); assert.equal(state.notify, false); assert.equal(state.state, "live");
      assert.equal(state.labels["herdr.tab"], tab.tab);
      assert.equal(surface.getSurfaceProcessId(record.handle), state.pid);
    }
    const ownTab = () => findTab(JSON.parse(run("herdr-app", ["ls"])), tab.tab);
    await until(() => terminals.every(t => ownTab()?.terminals.some((p: any) => p.terminal === t && p.pane)), "both native terminals must have visible panes");
    app("terminal.park", { terminal: tab.terminal });
    await until(() => ownTab()?.terminals.length === 2, "only the two Pi panels must remain visible");
    const status = JSON.parse(run("herdr-app", ["status"])); assert.equal(status.tab, tab.tab); assert.deepEqual(status.errors, []);
    const shot = join(root, "full.png"); run("herdr-app", ["shot", shot]);
    if (process.env.PI_TEST_HERDR_EVIDENCE) {
      const evidence = resolve(process.env.PI_TEST_HERDR_EVIDENCE); mkdirSync(dirname(evidence), { recursive: true });
      run("python3", ["-c", "from PIL import Image;import sys;im=Image.open(sys.argv[1]);w,h=im.size;im.crop((int(w*.12),int(h*.10),w,int(h*.96))).save(sys.argv[2])", shot, evidence]);
    }
    await surface.sendCommand(records[0].handle, "COORDINADOR\n  conserva estas líneas");
    surface.closeSurface(records[1].handle);
    assert.equal(JSON.parse(run("hc", ["get", records[0].terminal, "--json"])).state, "live", "cancelling one child must preserve its sibling");
    writeFileSync(join(records[0].dir, "release"), "go");
    await until(() => existsSync(join(records[0].dir, "settled")), "first child must settle after release");
    run("hc", ["send", records[0].terminal, "TECLADO_HERDR: interacción directa"]);
    await until(() => readFileSync(join(records[0].dir, "inputs"), "utf8").includes("TECLADO_HERDR"), "real terminal input must reach Pi");
    const inputs = readFileSync(join(records[0].dir, "inputs"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(inputs.some(v => v.text === "COORDINADOR\n  conserva estas líneas"));
    assert.ok(inputs.some(v => v.text === "TECLADO_HERDR: interacción directa" && v.source === "interactive"));
  } finally {
    const errors: unknown[] = [];
    for (const handle of surfaces) { try { surface.closeSurface(handle); } catch (e) { errors.push(e); } }
    if (tab) {
      try { if (findTab(JSON.parse(run("herdr-app", ["ls"])), tab.tab)) app("tab.close", { id: tab.tab, confirmed: true }); } catch (e) { errors.push(e); }
      for (const id of [...terminals, tab.terminal]) {
        try { run("hc", ["kill", id]); } catch {}
        try { run("hc", ["rm", id]); } catch {}
      }
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    try { app("tab.select", { id: original.tab }); app("pane.focus", { pane: original.focused_pane }); } catch (e) { errors.push(e); }
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(protectedPaths.map(hash), hashes, "settings, keys and layout must remain unchanged");
    assert.deepEqual(errors, [], "owned resources must close cleanly");
  }
});
