import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestEnv, createExtensionDriver, shellEscape } from "../harness.ts";

const env = createTestEnv();
const fixture = resolve("test/integration/fixtures/faux-interactive.ts");
const skillDir = join(env.agentDir, "skills", "bootstrap-fixture");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), "---\nname: bootstrap-fixture\ndescription: Offline fixture instructions\n---\nBOOTSTRAP_SKILL_BODY_MARKER\n");
const agentFile = join(env.agentDir, "agents", "test-echo.md");
writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("tools: read", "tools: read\nskills: bootstrap-fixture"));
process.env.PI_TEST_FIRST_CONTEXT = join(env.root, "first-context");
const bin = join(env.root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "pi"), `#!/bin/bash\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "$@" -e ${shellEscape(fixture)}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_SIMPLE = "1";
const driver = await createExtensionDriver(env);
const resultFor = (entry: any) => entry.message?.customType === "subagent_result" && entry.message?.details?.name === "offline-tui";
try {
  const first = await driver.tool("subagent").execute("launch", { agent: "test-echo", name: "offline-tui", model: "interactive-faux/local", task: "FIRST_LITERAL\nsecond line" }, undefined, undefined, driver.ctx);
  assert.equal(first.details.status, "started", JSON.stringify(first));
  const delivered = await driver.waitForMessage(resultFor, { timeout: 15000 });
  const firstContext = readFileSync(process.env.PI_TEST_FIRST_CONTEXT!, "utf8");
  assert.ok(firstContext.includes("BOOTSTRAP_SKILL_BODY_MARKER"), "first request must contain expanded skill body");
  assert.ok(firstContext.includes("FIRST_LITERAL"), "first request must also contain the task");
  assert.ok(firstContext.indexOf("BOOTSTRAP_SKILL_BODY_MARKER") < firstContext.indexOf("FIRST_LITERAL"), "skill must precede task in first request");
  assert.equal(delivered.message.details.exitCode, 0, JSON.stringify(delivered));
  assert.match(delivered.message.content, /FIRST_LITERAL/);
  const offset = driver.sentMessages.length;
  writeFileSync(`${first.details.sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "STALE_STARTUP_FAILURE" }));
  const resumed = await driver.tool("subagent_message").execute("resume", { name: "offline-tui", message: "RESUMED_LITERAL\n  unchanged" }, undefined, undefined, driver.ctx);
  assert.equal(resumed.details.status, "started", JSON.stringify(resumed));
  const final = await driver.waitForMessage(resultFor, { from: offset, timeout: 15000 });
  assert.equal(final.message.details.exitCode, 0, JSON.stringify(final));
  assert.match(final.message.content, /RESUMED_LITERAL/);
  const inputs = readFileSync(process.env.PI_TEST_INPUTS!, "utf8").trim().split("\n").map(line => JSON.parse(line).text);
  assert.equal(inputs.filter(text => text.includes("FIRST_LITERAL")).length, 1);
  assert.equal(inputs.filter(text => text.includes("RESUMED_LITERAL")).length, 1);
  for (const script of [first.details.launchScriptFile, resumed.details.launchScriptFile]) {
    assert.doesNotMatch(readFileSync(script, "utf8"), /--mode\s+rpc/);
  }
  assert.deepEqual(JSON.parse(readFileSync(process.env.PI_TEST_MODE!, "utf8")), { mode: "tui", stdin: true, stdout: true });
} finally { await driver.stop(); }
