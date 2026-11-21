import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openCreationStore } from '../bridge/creation-store.mjs';

function fixture(t) {
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-creations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'creations.json');
  return { path, open: () => openCreationStore(path) };
}
const record = { workspaceId: 'w1', agentId: 'new-agent', nameHash: 'a'.repeat(64) };

test('creation intent and outcome survive restart without storing the spoken title or profile', t => {
  const f = fixture(t), store = f.open();
  store.reserve('r1', record);
  assert.deepEqual(f.open().pending('w1', record.nameHash), [{ requestId: 'r1', ...record, status: 'pending' }]);
  assert.throws(() => store.reserve('r1', record), { code: 'CREATION_REPLAY' });
  store.markCreated('r1');
  assert.equal(f.open().get('r1').status, 'created');
  assert.deepEqual(f.open().pending('w1', record.nameHash), []);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.path, 'utf8')).requests.r1).sort(), ['agentId', 'nameHash', 'status', 'workspaceId']);
});

test('an unreadable creation journal blocks creation rather than forgetting pending effects', t => {
  const f = fixture(t);
  for (const value of ['{', '{"version":2,"requests":{}}', '{"version":1,"requests":{"r":{"status":"pending"}}}']) {
    writeFileSync(f.path, value);
    assert.throws(f.open, { code: 'CREATION_STORE_INVALID' });
  }
});

test('failed creation reservation leaves the in-memory journal unchanged', t => {
  const f = fixture(t), store = f.open();
  mkdirSync(f.path);
  assert.throws(() => store.reserve('r1', record), { code: 'CREATION_STORE_WRITE_FAILED' });
  assert.equal(store.get('r1'), null);
});
