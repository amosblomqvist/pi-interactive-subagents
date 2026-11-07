import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestEnv, createExtensionDriver, shellEscape } from "../harness.ts";

const env = createTestEnv();
const file = (name: string) => join(env.root, name);
const bin = file("bin"); mkdirSync(bin);
writeFileSync(join(bin, "pi"), `#!/bin/bash\nexec ${shellEscape(process.execPath)} ${shellEscape(process.env.PI_TEST_CLI!)} "$@" -e ${shellEscape(resolve("test/integration/fixtures/faux-interactive.ts"))}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_TEST_POLICY = file("scope");
process.env.PI_TEST_POLICY_READ = file("read-target");
writeFileSync(file("read-target"), "offline policy fixture");
writeFileSync(join(env.agentDir, "agents", "policy.md"), "---\nname: policy\nmodel: interactive-faux/local\ntools: read, grep, find, ls\nextensions: false\nskills: false\nallowed_subagents: none\nmax_turns: 2\nprompt_mode: append\nauto-exit: true\n---\nPOLICY_IDENTITY\n");
writeFileSync(join(env.agentDir, "subagents.json"), JSON.stringify({ ...JSON.parse(readFileSync(resolve("config.json.example"), "utf8")), surfaceBackend: "process", includeBundledAgents: false, allowProjectAgents: false, requireProfile: true }));
const projectAgentDir = join(env.dir, ".pi", "agent");
mkdirSync(projectAgentDir, { recursive: true });
writeFileSync(join(projectAgentDir, "subagents.json"), JSON.stringify({ status: { enabled: false }, allowProjectAgents: true, requireProfile: false }));
writeFileSync(join(projectAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "must-not-use-project", defaultModel: "must-not-use-project" }));
mkdirSync(join(env.dir, ".pi", "agents"), { recursive: true });
writeFileSync(join(env.dir, ".pi", "agents", "project-only.md"), "---\nname: project-only\n---\nMust not be discovered");
mkdirSync(join(env.agentDir, "extensions"), { recursive: true });
writeFileSync(join(env.agentDir, "extensions", "forbidden.ts"), `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(file("extension-loaded"))}, 'bad'); }`);
mkdirSync(join(env.agentDir, "skills", "forbidden"), { recursive: true });
writeFileSync(join(env.agentDir, "skills", "forbidden", "SKILL.md"), "---\nname: forbidden\ndescription: Must not be discovered\n---\nFORBIDDEN_SKILL_BODY");
const driver = await createExtensionDriver(env);
try {
  const { __test__ } = await import("../../../pi-extension/subagents/index.ts");
  assert.ok(__test__.discoverAgentDefinitions().every(agent => agent.source === "global"));
  const launch = (params: any) => driver.tool("subagent").execute("invalid", { name: "invalid", task: "must not start", ...params }, undefined, undefined, driver.ctx);
  assert.equal((await launch({})).details.error, "agent required");
  assert.equal((await launch({ agent: "does-not-exist" })).details.error, "unknown agent");
  const invalidProfile = join(env.agentDir, "agents", "invalid.md");
  for (const declaration of ["max_turns: 0", "allowed_subagents: none\nsubagent_agents: policy", "prompt_mode: append\nsystem-prompt: replace", "skills: false\nskill: forbidden"]) {
    writeFileSync(invalidProfile, `---\nname: invalid\n${declaration}\n---\nInvalid restrictions`);
    await assert.rejects(launch({ agent: "invalid" }), /Invalid max_turns|Conflicting/);
  }
  for (const declaration of ["max_turns:", "skills: true\nskills: false"]) {
    writeFileSync(invalidProfile, `---\nname: invalid\n${declaration}\n---\nAmbiguous restrictions`);
    assert.throws(() => __test__.discoverAgentDefinitions(), /Invalid max_turns|Duplicate/);
  }
  rmSync(invalidProfile);
  assert.ok(!existsSync(join(env.agentDir, "sessions")), "rejection must precede session creation");
  const first = await driver.tool("subagent").execute("policy", { agent: "policy", name: "policy", cwd: env.dir, task: "Read repeatedly" }, undefined, undefined, driver.ctx);
  assert.equal(first.details.status, "started", JSON.stringify(first));
  assert.ok(first.details.sessionFile.startsWith(join(env.agentDir, "sessions") + "/"), `cwd must not move sessions into project config: ${first.details.sessionFile}`);
  assert.ok(!existsSync(join(projectAgentDir, "sessions")));
  const done = await driver.waitForMessage((entry: any) => entry.message?.customType === "subagent_result" && entry.message?.details?.name === "policy", { timeout: 15000 });
  assert.ok(existsSync(file("scope")), `skills:false must reach provider, not bootstrap /skill:false: ${JSON.stringify(done)}`);
  const scope = JSON.parse(readFileSync(file("scope"), "utf8"));
  assert.deepEqual(scope.active.sort(), ["ask_question", "find", "grep", "ls", "read"]);
  assert.deepEqual(scope.registered.sort(), ["ask_question", "find", "grep", "ls", "read"]);
  assert.deepEqual(scope.skills, []);
  assert.equal(scope.agentDir, env.agentDir);
  assert.equal(scope.cwd, env.dir);
  assert.match(JSON.stringify(scope.context), /POLICY_IDENTITY/);
  assert.notEqual(done.message.details.exitCode, 0);
  assert.match(done.message.details.errorMessage, /turn limit.*2/i);
  const entries = readFileSync(first.details.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.message?.role === "assistant" && entry.message.stopReason === "toolUse").length, 2);
  assert.equal(readFileSync(file("scope.requests"), "utf8").trim().split("\n").length, 2, "no third provider request after abort");
  const loadout = JSON.parse(readFileSync(`${first.details.sessionFile}.loadout.json`, "utf8"));
  assert.equal(loadout.maxTurns, 2); assert.equal(loadout.disableSkills, true); assert.equal(loadout.disableExtensions, true); assert.deepEqual(loadout.spawnable, []);
  assert.equal(loadout.agentDir, env.agentDir);
  assert.equal(loadout.cwd, env.dir);
  const scriptsDir = join(first.details.launchScriptFile, "..");
  const scriptsBefore = readdirSync(scriptsDir).sort();
  writeFileSync(`${first.details.sessionFile}.loadout.json`, JSON.stringify({ ...loadout, agentDir: projectAgentDir }));
  const refused = await driver.tool("subagent_message").execute("old-project-resume", { name: "policy", message: "Must refuse project snapshot" }, undefined, undefined, driver.ctx);
  assert.match(refused.details.error, /personal.*agent.*directory|agent.*directory.*personal/i);
  assert.deepEqual(readdirSync(scriptsDir).sort(), scriptsBefore, "refusal must precede launch script creation");
  assert.equal(readFileSync(file("scope.requests"), "utf8").trim().split("\n").length, 2);
  writeFileSync(`${first.details.sessionFile}.loadout.json`, JSON.stringify(loadout));
  const offset = driver.sentMessages.length;
  writeFileSync(join(env.agentDir, "agents", "policy.md"), "---\nname: policy\ntools: read, bash, write\n---\nChanged profile must not expand resume permissions");
  const resumed = await driver.tool("subagent_message").execute("resume", { name: "policy", message: "Read again" }, undefined, undefined, driver.ctx);
  assert.equal(resumed.details.status, "started", JSON.stringify(resumed));
  const resumedDone = await driver.waitForMessage((entry: any) => entry.message?.customType === "subagent_result" && entry.message?.details?.name === "policy", { from: offset, timeout: 15000 });
  const resumedScope = JSON.parse(readFileSync(file("scope"), "utf8"));
  assert.deepEqual(resumedScope.active.sort(), scope.active);
  assert.deepEqual(resumedScope.registered.sort(), scope.registered);
  assert.deepEqual(resumedScope.skills, []);
  assert.equal(resumedScope.agentDir, env.agentDir);
  assert.equal(resumedScope.cwd, env.dir);
  assert.ok(!existsSync(join(projectAgentDir, "sessions")));
  assert.ok(!existsSync(file("extension-loaded")), "global extensions never load on initial or resume");
  assert.doesNotMatch(JSON.stringify(resumedScope.context), /FORBIDDEN_SKILL_BODY/);
  assert.notEqual(resumedDone.message.details.exitCode, 0);
  assert.match(resumedDone.message.details.errorMessage, /turn limit.*2/i);
  const resumedEntries = readFileSync(first.details.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(resumedEntries.filter(entry => entry.message?.role === "assistant" && entry.message.stopReason === "toolUse").length, 4, "resume gets exactly two more turns");
  assert.equal(readFileSync(file("scope.requests"), "utf8").trim().split("\n").length, 4);
  for (const script of [first.details.launchScriptFile, resumed.details.launchScriptFile]) {
    const text = readFileSync(script, "utf8");
    assert.match(text, /--no-skills/); assert.match(text, /--no-extensions/); assert.match(text, /PI_SUBAGENT_MAX_TURNS='2'/);
  }
} finally { await driver.stop(); }
