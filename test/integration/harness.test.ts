import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupTestEnv,
  createExtensionDriver,
  createTestEnv,
  isSubagentEnvironmentKey,
  restoreSubagentEnvironment,
  stageExplicitPiConfigFiles,
  stripSubagentEnvironment,
  terminateTestSurfaces,
} from "./harness.ts";

test("stages only explicitly selected auth/model files opaquely in the private fixture", () => {
  const sources = mkdtempSync(join(tmpdir(), "pi-integ-config-source-"));
  const env = createTestEnv();
  const authSource = join(sources, "chosen-auth.bin");
  const modelsSource = join(sources, "chosen-models.bin");
  const authBytes = Buffer.from([0, 255, 12, 34, 56, 78]);
  const modelsBytes = Buffer.from([123, 10, 32, 125]);
  writeFileSync(authSource, authBytes);
  writeFileSync(modelsSource, modelsBytes);

  try {
    const staged = stageExplicitPiConfigFiles(env, {
      PI_TEST_AUTH_FILE: authSource,
      PI_TEST_MODELS_FILE: modelsSource,
    });
    assert.deepEqual(staged.sort(), [
      join(env.agentDir, "auth.json"),
      join(env.agentDir, "models.json"),
    ].sort());
    assert.deepEqual(readFileSync(join(env.agentDir, "auth.json")), authBytes);
    assert.deepEqual(readFileSync(join(env.agentDir, "models.json")), modelsBytes);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(env.agentDir, "auth.json")).mode & 0o077, 0);
      assert.equal(statSync(join(env.agentDir, "models.json")).mode & 0o077, 0);
    }

    cleanupTestEnv(env);
    assert.equal(existsSync(env.root), false);
  } finally {
    rmSync(sources, { recursive: true, force: true });
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("driver hides selected source paths from children and restores executor env", async () => {
  const sources = mkdtempSync(join(tmpdir(), "pi-integ-driver-auth-"));
  const authSource = join(sources, "synthetic-auth.json");
  const authBytes = Buffer.from("synthetic credential fixture");
  writeFileSync(authSource, authBytes, { mode: 0o600 });
  const previous = process.env.PI_TEST_AUTH_FILE;
  process.env.PI_TEST_AUTH_FILE = authSource;
  const env = createTestEnv();
  let driver: Awaited<ReturnType<typeof createExtensionDriver>> | undefined;

  try {
    driver = await createExtensionDriver(env);
    assert.equal(process.env.PI_TEST_AUTH_FILE, undefined);
    assert.deepEqual(readFileSync(join(env.agentDir, "auth.json")), authBytes);
    await driver.stop();
    driver = undefined;
    assert.equal(process.env.PI_TEST_AUTH_FILE, authSource);
    assert.equal(existsSync(env.root), false);
  } finally {
    if (driver) await driver.stop();
    if (previous === undefined) delete process.env.PI_TEST_AUTH_FILE;
    else process.env.PI_TEST_AUTH_FILE = previous;
    rmSync(sources, { recursive: true, force: true });
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("driver setup failure removes a partially staged synthetic credential", async () => {
  const sources = mkdtempSync(join(tmpdir(), "pi-integ-partial-auth-"));
  const authSource = join(sources, "synthetic-auth.json");
  writeFileSync(authSource, Buffer.from("synthetic partial credential"), { mode: 0o600 });
  const previousAuth = process.env.PI_TEST_AUTH_FILE;
  const previousModels = process.env.PI_TEST_MODELS_FILE;
  process.env.PI_TEST_AUTH_FILE = authSource;
  process.env.PI_TEST_MODELS_FILE = join(sources, "missing-models.json");
  const env = createTestEnv();

  try {
    await assert.rejects(() => createExtensionDriver(env), /missing-models\.json|ENOENT/);
    assert.equal(existsSync(env.root), false);
    assert.equal(process.env.PI_TEST_AUTH_FILE, authSource);
    assert.equal(process.env.PI_TEST_MODELS_FILE, join(sources, "missing-models.json"));
  } finally {
    if (previousAuth === undefined) delete process.env.PI_TEST_AUTH_FILE;
    else process.env.PI_TEST_AUTH_FILE = previousAuth;
    if (previousModels === undefined) delete process.env.PI_TEST_MODELS_FILE;
    else process.env.PI_TEST_MODELS_FILE = previousModels;
    rmSync(sources, { recursive: true, force: true });
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("does not discover or copy auth/model files without explicit opt-in paths", () => {
  const env = createTestEnv();
  try {
    assert.deepEqual(stageExplicitPiConfigFiles(env, {}), []);
    assert.equal(existsSync(join(env.agentDir, "auth.json")), false);
    assert.equal(existsSync(join(env.agentDir, "models.json")), false);
  } finally {
    cleanupTestEnv(env);
  }
});

test("rejects non-file config selections before a child can start", () => {
  const env = createTestEnv();
  try {
    assert.throws(
      () => stageExplicitPiConfigFiles(env, { PI_TEST_AUTH_FILE: env.dir }),
      /PI_TEST_AUTH_FILE must select a concrete regular file/,
    );
    assert.equal(existsSync(join(env.agentDir, "auth.json")), false);
  } finally {
    cleanupTestEnv(env);
  }
});

test("strips and restores PI_SUBAGENT_* plus plural config in every casing", () => {
  const environment: NodeJS.ProcessEnv = {
    PATH: "kept",
    PI_SUBAGENT_ALLOWED: "scout",
    Pi_SubAgent_Name: "mixed",
    pi_subagent_future_flag: "future",
    PI_SUBAGENTS_CONFIG: "C:\\executor\\config.json",
    pi_subagents_config: "C:\\executor\\lower-config.json",
  };

  const snapshot = stripSubagentEnvironment(environment);
  assert.deepEqual(environment, { PATH: "kept" });

  environment.pI_sUbAgEnT_new_contamination = "remove-me";
  environment.Pi_SubAgents_Config = "remove-config-too";
  restoreSubagentEnvironment(environment, snapshot);
  assert.equal(environment.PATH, "kept");
  assert.equal(environment.PI_SUBAGENT_ALLOWED, "scout");
  assert.equal(environment.Pi_SubAgent_Name, "mixed");
  assert.equal(environment.pi_subagent_future_flag, "future");
  assert.equal(environment.PI_SUBAGENTS_CONFIG, "C:\\executor\\config.json");
  assert.equal(environment.pi_subagents_config, "C:\\executor\\lower-config.json");
  assert.equal(environment.pI_sUbAgEnT_new_contamination, undefined);
  assert.equal(environment.Pi_SubAgents_Config, undefined);
});

test("synthetic parent driver filters inherited/future subagent contamination and restores it", async () => {
  const before = Object.entries(process.env)
    .filter(([key]) => isSubagentEnvironmentKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const env = createTestEnv();
  const driver = await createExtensionDriver(env);

  assert.deepEqual(
    Object.keys(process.env).filter((key) => isSubagentEnvironmentKey(key)),
    [],
  );
  process.env.Pi_SubAgent_Future_Contamination = "remove-on-restore";
  process.env.Pi_SubAgents_Config = "remove-config-on-restore";
  await driver.stop();

  const after = Object.entries(process.env)
    .filter(([key]) => isSubagentEnvironmentKey(key))
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(after, before);
});

test("cleanup terminates test-owned surfaces before removing the private fixture", () => {
  const env = createTestEnv();
  env.surfaces.push("process:synthetic-a", "process:synthetic-b");
  const order: string[] = [];

  cleanupTestEnv(env, {
    close(surface) {
      order.push(`close:${surface}`);
    },
    removeRoot(root) {
      order.push("remove");
      rmSync(root, { recursive: true, force: true });
    },
  });

  assert.deepEqual(order, [
    "close:process:synthetic-a",
    "close:process:synthetic-b",
    "remove",
  ]);
});

test("cleanup reports deletion failures and retains a synthetic secret fixture for diagnosis", () => {
  const env = createTestEnv();
  const syntheticSecret = join(env.agentDir, "auth.json");
  writeFileSync(syntheticSecret, Buffer.from([9, 8, 7, 6]), { mode: 0o600 });
  try {
    assert.throws(
      () => cleanupTestEnv(env, {
        removeRoot() {
          throw new Error("synthetic deletion failure");
        },
      }),
      new RegExp(`Failed to remove private test fixture.*${env.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.equal(existsSync(env.root), true);
    assert.equal(existsSync(syntheticSecret), true);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("surface termination failures are never swallowed", () => {
  assert.throws(
    () => terminateTestSurfaces(["process:synthetic"], () => {
      throw new Error("synthetic termination failure");
    }),
    /Failed to terminate test-owned child processes/,
  );
});
