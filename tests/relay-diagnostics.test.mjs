import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('SSH diagnostics distinguish explicit port use from an unspecified forwarding failure', async () => {
  const { classifySshFailure } = await import('../bridge/relay-diagnostics.mjs');
  const cases = [
    ['bind: Address already in use', 'port_in_use'],
    ['Error: remote port forwarding failed for listen port 17001', 'remote_forward_failed'],
    ['Permission denied (publickey)', 'authentication_failed'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host_key_failed'],
    ['Host key verification failed.', 'host_key_failed'],
    ['connect to host example.invalid port 22: Connection timed out', 'connection_timeout'],
    ['Could not resolve hostname example.invalid', 'dns_failed'],
    ['Connection reset by peer', 'connection_lost'],
    ['Network is unreachable', 'network_unreachable'],
    ['connect to host example.invalid port 22: Connection refused', 'connection_refused'],
    ['private unrecognized failure', 'unknown_exit'],
  ];
  for (const [text, expected] of cases) assert.equal(classifySshFailure(text), expected);
  assert.equal(classifySshFailure('', 'ENOENT'), 'executable_missing');
  assert.equal(classifySshFailure('', 'EACCES'), 'permission_denied');
});

test('relay event history survives reload, stays bounded, and never persists raw errors or unknown fields', async t => {
  const { recordRelayEvent } = await import('../bridge/relay-diagnostics.mjs');
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-relay-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.json');
  writeFileSync(path, JSON.stringify({ events: [{ type: 'exited', at: new Date().toISOString(), reason: 'connection_lost', secret: 'fixture-secret' }] }));
  recordRelayEvent(path, { type: 'started', pid: 123, raw: 'fixture-secret' });
  let saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.events[0].reason, 'connection_lost');
  assert.equal(saved.events[1].pid, 123);
  for (let i = 0; i < 40; i++) recordRelayEvent(path, { type: 'exited', reason: 'unknown_exit', exitCode: 255, stderr: 'fixture-secret' });
  saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.events.length, 32);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /fixture-secret|stderr|raw|secret/);
});

test('relay diagnostics remove only events older than 14 days', async t => {
  const { pruneRelayEvents } = await import('../bridge/relay-diagnostics.mjs');
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-relay-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.json');
  const now = Date.now(), age = 14 * 24 * 60 * 60 * 1000;
  writeFileSync(path, JSON.stringify({ events: [
    { type: 'exited', at: new Date(now - age - 1).toISOString(), reason: 'connection_lost' },
    { type: 'started', at: new Date(now - 1000).toISOString(), pid: 123 },
  ] }));
  pruneRelayEvents(path, now);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].pid, 123);
});
