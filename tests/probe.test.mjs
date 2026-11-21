import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function probe(args) {
  return spawnSync(process.execPath, ['bridge/probe.mjs', ...args], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, PASEO_URL: 'invalid-endpoint-that-must-not-be-used' },
  });
}

test('help works offline and documents explicit text opt-in', () => {
  const result = probe(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--show-text/);
});

test('write commands are rejected before any connection', () => {
  const result = probe(['--send', 'must-not-run']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENTS');
});

test('invalid page sizes are rejected before any connection', () => {
  const result = probe(['--agent', 'agent-one', '--limit', '0']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENTS');
});
