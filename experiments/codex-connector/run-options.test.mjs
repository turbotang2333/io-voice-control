import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunOptions, independentProfile } from './run-options.mjs';

test('explicit independent test uses its own backend without changing the saved profile', () => {
  assert.deepEqual(parseRunOptions(['serve', '--config', 'local.json', '--independent-test']),
    { mode: 'serve', configPath: 'local.json', independentTest: true });
  assert.deepEqual(parseRunOptions(['check']), { mode: 'check', configPath: undefined, independentTest: false });
  const saved = { navigation: true, sharedConnection: { endpoint: 'example' } };
  const adapted = independentProfile(saved, true);
  assert.equal(adapted.navigation, true);
  assert.equal(Object.hasOwn(adapted, 'sharedConnection'), false);
  assert.ok(saved.sharedConnection);
  assert.deepEqual(independentProfile(saved, false), saved);
  for (const args of [['serve'], ['serve', '--independent-test'], ['check', '--bad'], ['check', '--independent-test', '--independent-test']])
    assert.throws(() => parseRunOptions(args), { code: 'USAGE' });
});
