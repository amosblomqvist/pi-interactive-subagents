import './isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import doneExtension from '../pi-extension/subagents/subagent-done.ts';
import subagentsExtension, { __test__ as subagentsTestApi } from '../pi-extension/subagents/index.ts';
import { cancelOwnedSubagent } from '../pi-extension/subagents/cancellation.ts';
import { descendantProcessIds } from '../pi-extension/subagents/surface.ts';
import { readSubagentActivityFile } from '../pi-extension/subagents/activity.ts';
import { createStatusState, observeStatus, classifyStatus, formatStatusLine } from '../pi-extension/subagents/status.ts';

function isIsolatedSubagentKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith('PI_SUBAGENT_') || upper === 'PI_SUBAGENTS_CONFIG';
}

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-wait-reason-'));
  const saved = { ...process.env };
  const countKey = Symbol.for('pi-subagents/running-children-count');
  const namesKey = Symbol.for('pi-subagents/running-children-names');
  const savedCount = (globalThis as any)[countKey];
  const savedNames = (globalThis as any)[namesKey];
  for (const key of Object.keys(process.env)) if (isIsolatedSubagentKey(key)) delete process.env[key];
  process.env.PI_SUBAGENT_AUTO_EXIT = '1';
  process.env.PI_SUBAGENT_ID = 'fixture';
  process.env.PI_SUBAGENT_SESSION = path.join(dir, 'session.jsonl');
  process.env.PI_SUBAGENT_ACTIVITY_FILE = path.join(dir, 'activity.json');
  const events = new Map<string, Function>();
  const tools = new Map<string, any>();
  doneExtension({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerShortcut() {},
  } as any);
  let shutdowns = 0;
  const ctx = { shutdown() { shutdowns++; } };
  t.after(() => {
    events.get('session_shutdown')!({ reason: 'quit' }, ctx);
    for (const key of Object.keys(process.env)) if (isIsolatedSubagentKey(key)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (isIsolatedSubagentKey(key) && value !== undefined) process.env[key] = value;
    (globalThis as any)[countKey] = savedCount;
    (globalThis as any)[namesKey] = savedNames;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { events, tools, ctx, dir, shutdowns: () => shutdowns, countKey, namesKey,
    activity: () => readSubagentActivityFile(path.join(dir, 'activity.json'), 'fixture') };
}

test('nested handoff delivery wakes the waiting parent and closes exactly once after its completion turn', t => {
  const f = setup(t);
  let children = 1;
  (globalThis as any)[f.countKey] = () => children;
  (globalThis as any)[f.namesKey] = () => ['bootstrap-recon'];

  // The spawning turn settles while its child is still running. The parent
  // subagent must remain alive and advertise exactly what it is waiting for.
  f.events.get('agent_start')!({}, f.ctx);
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 0);
  const waiting = f.activity();
  assert.equal(waiting.ok, true);
  if (!waiting.ok) return;
  assert.equal(waiting.activity.phase, 'waiting');
  assert.match((waiting.activity as any).waitingReason, /children.*bootstrap-recon/);

  // index.ts removes the completed child and injects its full handoff with
  // triggerTurn=true. Reproduce the resulting run: shutdown is requested only
  // after that handoff-driven turn has completed, never in the delivery gap.
  children = 0;
  const handoff = '## Handoff\nStatus: complete\nSummary:\n- CHILD_HANDOFF_PRESERVED';
  f.events.get('agent_start')!({}, f.ctx);
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: handoff }] }] }, f.ctx);
  assert.equal(f.shutdowns(), 0);
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 1);

  // Pi shutdown is deferred; a duplicate settled callback must not use the
  // retiring context or enqueue a second close.
  f.events.get('agent_settled')!({}, { shutdown() { throw new Error('duplicate close'); } });
  assert.equal(f.shutdowns(), 1);
});

test('pending child question remains parked after notification and closes only after the answer turn', async t => {
  const f = setup(t);
  (globalThis as any)[f.countKey] = () => 0;
  const ask = f.tools.get('ask_question');
  assert.ok(ask);

  f.events.get('agent_start')!({}, f.ctx);
  await ask.execute('ask-1', { question: 'Which contract?' });
  // The parent watcher removes .ask once notification delivery succeeds. That
  // must not make the question cease being pending before an answer arrives.
  fs.unlinkSync(path.join(f.dir, 'session.jsonl.ask'));
  await assert.rejects(
    () => ask.execute('ask-2', { question: 'A second question?' }),
    /already has a pending question/i,
  );
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 0);

  // A grandchild result can trigger a fresh agent run, but it is not an answer
  // to this pending parent question. agent_start alone must not clear the gate.
  f.events.get('agent_start')!({}, f.ctx);
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 0);

  f.events.get('input')!({}, f.ctx);
  f.events.get('agent_start')!({}, f.ctx);
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('agent_settled')!({}, f.ctx);
  assert.equal(f.shutdowns(), 1);
});

test('result delivery presentation preserves the complete structured child handoff', () => {
  const marker = 'CHILD_HANDOFF_PRESERVED';
  const summary = [
    '## Handoff',
    'Status: complete',
    'Summary:',
    `- ${marker}`,
    'Files:',
    '- src/nested.ts',
    'Verification:',
    '- npm test (passed)',
    'Risks/Blockers:',
    '- None.',
    'Next:',
    '- None.',
  ].join('\n');
  const handoff = subagentsTestApi.createSubagentHandoff(summary, { exitCode: 0 });
  const presentation = subagentsTestApi.resolveResultPresentation(
    { exitCode: 0, elapsed: 2, summary, handoff },
    'nested-child',
  );

  assert.match(presentation, new RegExp(marker));
  assert.match(presentation, /src\/nested\.ts/);
  assert.match(presentation, /npm test \(passed\)/);
  assert.match(presentation, /Reported handoff status: complete/);
});

test('a thrown shutdown request remains visible and retries with a fresh settled context', t => {
  const f = setup(t);
  (globalThis as any)[f.countKey] = () => 0;
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);

  assert.throws(
    () => f.events.get('agent_settled')!({}, { shutdown() { throw new Error('stale ctx rejected'); } }),
    /stale ctx rejected/,
  );
  assert.equal(f.shutdowns(), 0);
  assert.doesNotThrow(() => f.events.get('agent_settled')!({}, f.ctx));
  assert.equal(f.shutdowns(), 1);
});

test('session generation rejects old watcher delivery after a replacement session starts', () => {
  assert.equal(subagentsTestApi.canDeliverToSession(true, 3, 1), false);
  assert.equal(subagentsTestApi.canDeliverToSession(false, 1, 1), false);
  assert.equal(subagentsTestApi.canDeliverToSession(true, 3, 3), true);
});

test('settled event after shutdown does not use an invalidated context', t => {
  const f = setup(t);
  (globalThis as any)[f.countKey] = () => 0;
  f.events.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, f.ctx);
  f.events.get('session_shutdown')!({ reason: 'quit' }, f.ctx);
  assert.doesNotThrow(() => f.events.get('agent_settled')!({}, { shutdown() { throw new Error('stale context'); } }));
});

test('cancellation is available as a tool and a slash command without resuming unknown names', async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  subagentsExtension({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut() {}, registerMessageRenderer() {} } as any);
  assert.ok(tools.has('subagent_cancel'));
  assert.ok(commands.has('subagent-cancel'));
  await assert.rejects(tools.get('subagent_cancel').execute('fixture', { name: 'unknown' }), /No running subagent/);
});

test('cancellation targets one exact owned name and leaves siblings untouched', () => {
  const first = { name: 'worker', surface: 'process:1', abortController: new AbortController() };
  const second = { name: 'worker-other', surface: 'process:2', abortController: new AbortController() };
  const closed: string[] = [];
  assert.throws(() => cancelOwnedSubagent('work', [first, second], s => closed.push(s)), /No running subagent/);
  assert.deepEqual(closed, []);
  cancelOwnedSubagent('worker', [first, second], s => closed.push(s));
  assert.deepEqual(closed, ['process:1']);
  assert.equal(first.abortController.signal.aborted, true);
  assert.equal(second.abortController.signal.aborted, false);
  assert.throws(() => cancelOwnedSubagent('worker-other', [second], () => { throw new Error('kill failed'); }), /kill failed/);
  assert.equal(second.abortController.signal.aborted, false);
});

test('descendant selection is leaf-first, cycle-safe, and excludes unrelated processes', () => {
  const table = '1 0\n10 1\n20 10\n30 20\n40 1\n50 40\n10 30\ninvalid row';
  assert.deepEqual(descendantProcessIds(10, table), [30, 20]);
});

test('waiting status renders its reason rather than a generic idle label', () => {
  const state = observeStatus(createStatusState({ source: 'pi', startTimeMs: 0 }), {
    snapshot: 'present', updatedAt: 100, sequence: 1, phase: 'waiting', waitingSince: 100,
    activityLabel: 'children (1): bootstrap-recon',
  }, 100);
  assert.match(formatStatusLine('worker', classifyStatus(state, 200)), /children.*bootstrap-recon/);
});
