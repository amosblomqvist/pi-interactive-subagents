import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { resolveBackgroundBash } from '../pi-extension/subagents/surface.ts';

const root = path.resolve(import.meta.dirname, '..');
function isIsolatedSubagentKey(key) {
  const upper = key.toUpperCase();
  return upper.startsWith('PI_SUBAGENT_') || upper === 'PI_SUBAGENTS_CONFIG';
}

function stripIsolatedSubagentEnvironment(environment) {
  const snapshot = [];
  for (const key of Object.keys(environment)) {
    if (!isIsolatedSubagentKey(key)) continue;
    if (environment[key] !== undefined) snapshot.push([key, environment[key]]);
    delete environment[key];
  }
  return snapshot;
}

function restoreIsolatedSubagentEnvironment(environment, snapshot) {
  for (const key of Object.keys(environment)) {
    if (isIsolatedSubagentKey(key)) delete environment[key];
  }
  for (const [key, value] of snapshot) environment[key] = value;
}

async function withIsolatedSubagentEnvironment(run) {
  const snapshot = stripIsolatedSubagentEnvironment(process.env);
  try {
    return await run();
  } finally {
    restoreIsolatedSubagentEnvironment(process.env, snapshot);
  }
}

const cases = [
  {
    file: 'pi-extension/subagents/index.ts',
    tools: ['implementation_route', 'subagent', 'subagent_message', 'subagents_list', 'subagent_cancel'],
  },
  {
    file: 'pi-extension/subagents/subagent-done.ts',
    tools: ['ask_question'],
  },
  {
    file: 'pi-extension/subagents/tools/safe-bash.ts',
    tools: ['safe_bash'],
  },
];

test('manifest and lock pin Pi 0.85.1 without the obsolete pi-server workaround', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const metadata of [manifest, lock.packages['']]) {
    assert.equal(metadata.peerDependencies['@earendil-works/pi-coding-agent'], '0.85.1');
    assert.equal(metadata.peerDependencies['@earendil-works/pi-tui'], '0.85.1');
    assert.equal(metadata.dependencies?.['@earendil-works/pi-server'], undefined);
    assert.equal(metadata.devDependencies?.['@earendil-works/pi-server'], undefined);
  }
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], '0.85.1');
  assert.equal(manifest.devDependencies['@earendil-works/pi-tui'], '0.85.1');
  assert.equal(manifest.peerDependencies.typebox, '1.3.7');
});

test('Windows background launches select Git Bash over the system placeholder', () => {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const systemBash = 'C:\\Windows\\System32\\bash.exe';
  const existing = new Set([gitBash, systemBash]);

  assert.equal(resolveBackgroundBash({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    exists: candidate => existing.has(candidate),
    pathMatches: [systemBash],
  }), gitBash);
});

test('smoke isolation strips plural config case-insensitively and restores it', () => {
  const environment = {
    PATH: 'kept',
    PI_SUBAGENT_ID: 'child',
    Pi_SubAgents_Config: 'C:\\executor\\config.json',
  };
  const snapshot = stripIsolatedSubagentEnvironment(environment);
  assert.deepEqual(environment, { PATH: 'kept' });
  environment.pi_subagents_config = 'contamination';
  restoreIsolatedSubagentEnvironment(environment, snapshot);
  assert.deepEqual(environment, {
    PATH: 'kept',
    PI_SUBAGENT_ID: 'child',
    Pi_SubAgents_Config: 'C:\\executor\\config.json',
  });
});

test('absolute Windows subagent cwd is not joined to the parent cwd', async () => {
  const subagentsTestApi = await withIsolatedSubagentEnvironment(async () =>
    (await import('../pi-extension/subagents/index.ts')).__test__
  );
  const cwd = 'C:\\fixtures\\agent-config';
  assert.equal(subagentsTestApi.resolveRequestedCwd(cwd, 'C:\\other'), cwd);
});

test('Pi 0.85.1 loads every extension entry point and registers its tools', async (t) => {
  await withIsolatedSubagentEnvironment(async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-compat-'));
    t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

    const loaded = new Map();
    for (const expected of cases) {
      const result = await discoverAndLoadExtensions(
        [path.join(root, expected.file)],
        emptyDir,
        emptyDir,
      );
      assert.deepEqual(result.errors, [], expected.file);
      assert.equal(result.extensions.length, 1, expected.file);
      assert.deepEqual([...result.extensions[0].tools.keys()].sort(), expected.tools.sort());
      loaded.set(expected.file, result.extensions[0]);
    }

    const safeBash = loaded.get('pi-extension/subagents/tools/safe-bash.ts').tools.get('safe_bash').definition;
    await assert.rejects(
      safeBash.execute('blocked', { command: 'sudo whoami' }, undefined, undefined, undefined),
      /Command blocked by safe_bash/,
    );
    const harmless = await safeBash.execute(
      'harmless',
      { command: 'printf pi85-safe-bash-ok' },
      undefined,
      undefined,
      undefined,
    );
    assert.equal(harmless.content.find(part => part.type === 'text')?.text, 'pi85-safe-bash-ok');
  });
});
