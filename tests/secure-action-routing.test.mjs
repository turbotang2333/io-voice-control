import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRoutedSecureActions } from '../distribution/secure-action-routing.mjs';

test('secure routing switches to the isolated existing-user home and preserves an established primary identity', async () => {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/secure-routing'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-')), called = [];
  const routed = createRoutedSecureActions({ privateDirectory: root, create: path => ({
    status() { called.push(path); return { phase: 'unconfigured' }; },
    configure() { called.push(path); }, connect() { called.push(path); }, pair() { called.push(path); },
  }) });
  await routed.status(); assert.equal(called.pop(), root);
  const existing = join(root, 'secure-existing'); mkdirSync(existing);
  await routed.configure({}); assert.equal(called.pop(), existing);
  await routed.connect(); assert.equal(called.pop(), existing);
  writeFileSync(join(root, 'secure-link-enabled.json'), '{}');
  await routed.status(); assert.equal(called.pop(), root);
});
