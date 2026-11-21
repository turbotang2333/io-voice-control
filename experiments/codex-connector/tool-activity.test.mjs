import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readToolActivity } from './tool-activity.mjs';

const threadId = '11111111-1111-4111-8111-111111111111', turnId = 'test-turn';
const record = (type, payload) => JSON.stringify({ timestamp: '2026-11-08T10:00:00Z', type, payload }) + '\n';
const started = id => record('event_msg', { type: 'task_started', turn_id: id });
const call = id => record('response_item', { type: 'function_call', name: 'sleep', namespace: 'clock', status: 'completed',
  call_id: id, arguments: '{"duration_ms":15000,"private":"never expose"}' });
function fixture(t) {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'tool-activity-')), sessions = join(root, 'sessions'); mkdirSync(sessions);
  const path = join(sessions, 'synthetic.jsonl');
  const header = record('session_meta', { id: threadId, session_id: threadId });
  writeFileSync(path, header);
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(parent))); rmSync(root, { recursive: true, force: true }); });
  return { path, root, header, read: (options = {}) => readToolActivity({ codexHome: root, snapshotPath: path, threadId, turnId, ...options }) };
}

test('a persisted function call signals tool activity before an item_completed exists', t => {
  const f = fixture(t); appendFileSync(f.path, started(turnId) + call('call-1'));
  assert.equal(f.read(), true); // Model packet status completed does not mean its tool finished.
  appendFileSync(f.path, record('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'private output' }));
  assert.equal(f.read(), false);
});

test('parallel and custom calls remain pending until each has an output', t => {
  const f = fixture(t); appendFileSync(f.path, started(turnId) + call('call-1')
    + record('response_item', { type: 'custom_tool_call', name: 'run', call_id: 'call-2', input: 'private' })
    + record('response_item', { type: 'function_call_output', call_id: 'call-1', output: '' }));
  assert.equal(f.read(), true);
  appendFileSync(f.path, record('response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: '' }) + call('call-1'));
  assert.equal(f.read(), false); // A repeated start cannot resurrect a completed call.
});

test('thread identity, current turn and terminal fences prevent stale tool labels', t => {
  const f = fixture(t); appendFileSync(f.path, started('old-turn') + call('old-call'));
  assert.equal(f.read(), false);
  appendFileSync(f.path, started(turnId) + call('current-call'));
  assert.equal(f.read({ threadId: 'another-thread' }), false);
  assert.equal(f.read(), true);
  appendFileSync(f.path, record('event_msg', { type: 'task_complete', turn_id: turnId }));
  assert.equal(f.read(), false);
  appendFileSync(f.path, started('newer-turn') + call('new-call'));
  assert.equal(f.read(), false);
});

test('duplicate contexts cannot reopen a native turn after a terminal record', t => {
  const f = fixture(t); appendFileSync(f.path, started(turnId) + call('call-1')
    + record('event_msg', { type: 'task_complete', turn_id: turnId })
    + record('turn_context', { turn_id: turnId }) + call('duplicate-call'));
  assert.equal(f.read(), false);
});

test('bounded tails without a trustworthy turn boundary and out-of-scope paths fail closed', t => {
  const f = fixture(t); const outside = join(f.root, 'outside.jsonl');
  writeFileSync(outside, f.header + started(turnId) + call('outside-call'));
  assert.equal(f.read({ snapshotPath: outside }), false);
  appendFileSync(f.path, started(turnId) + record('response_item', { type: 'message', content: 'x'.repeat(1100000) }) + call('unscoped-call'));
  assert.equal(f.read(), false);
});

test('partial appended records are ignored and a malformed complete record invalidates activity', t => {
  const f = fixture(t); appendFileSync(f.path, started(turnId) + call('call-1') + '{"type":');
  assert.equal(f.read(), true);
  appendFileSync(f.path, '\n');
  assert.equal(f.read(), false);
});

test('a short tail read cannot hide a tool output or turn completion', t => {
  const f = fixture(t); const prefix = f.header + started(turnId) + call('call-1');
  appendFileSync(f.path, started(turnId) + call('call-1')
    + record('response_item', { type: 'function_call_output', call_id: 'call-1', output: '' }));
  const original = fs.readSync; let reads = 0;
  fs.readSync = (fd, buffer, offset, length, position) => {
    if (++reads === 2) return original(fd, buffer, offset, Buffer.byteLength(prefix), position);
    if (reads > 2) return 0; // The file was truncated before the rest could be read.
    return original(fd, buffer, offset, length, position);
  };
  syncBuiltinESMExports();
  try { assert.equal(f.read(), false); }
  finally { fs.readSync = original; syncBuiltinESMExports(); }
});

test('a changing file is treated as uncertain rather than showing a stale pending call', t => {
  const f = fixture(t); appendFileSync(f.path, started(turnId) + call('call-1'));
  const original = fs.readSync; let reads = 0;
  fs.readSync = (...args) => {
    const count = original(...args);
    if (++reads === 2) appendFileSync(f.path, record('event_msg', { type: 'task_complete', turn_id: turnId }));
    return count;
  };
  syncBuiltinESMExports();
  try { assert.equal(f.read(), false); }
  finally { fs.readSync = original; syncBuiltinESMExports(); }
});
