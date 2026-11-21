import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openConnectorIdentity } from './identity.mjs';

test('shortcut host identity survives restart but is different for another connector installation', t => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/connector-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'identity-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(parent) + '\\')); rmSync(root, { recursive: true, force: true }); });
  const path = join(root, 'host.json'), first = openConnectorIdentity(path);
  assert.equal(openConnectorIdentity(path), first);
  assert.notEqual(openConnectorIdentity(join(root, 'other.json')), first);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /USERPROFILE|codexHome|token|prompt/);
  writeFileSync(path, '{"version":1,"id":"invalid"}');
  assert.throws(() => openConnectorIdentity(path), { code: 'CONNECTOR_IDENTITY_INVALID' });
});
