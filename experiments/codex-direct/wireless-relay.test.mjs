import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function api() {
  assert.ok(existsSync(new URL('./wireless-relay.mjs', import.meta.url)), 'dedicated relay entry is missing');
  return import('./wireless-relay.mjs');
}

function stateRoot(t) {
  const base = join(homedir(), '.local', 'state', 'rayneo-paseo', 'codex-direct', 'tests');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'relay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('relay modes reject unknown or combined flags before doing any work', async () => {
  const { relayMode } = await api();
  assert.equal(relayMode([]), 'serve');
  assert.equal(relayMode(['--check']), 'check');
  assert.equal(relayMode(['--stop']), 'stop');
  for (const args of [['--enable'], ['--check', '--stop'], ['--check', '--check'], ['serve']]) assert.throws(() => relayMode(args));
});

test('only the SSH alias is used; both ports are fixed and the common relay protections are retained', async () => {
  const { codexRelayArguments } = await api();
  const args = codexRelayArguments({ sshHost: 'fixture-host', enabled: false, remotePort: 17467, localPort: 7468 });
  assert.equal(args.at(-1), 'fixture-host');
  for (const part of ['127.0.0.1:17469:127.0.0.1:17469', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=20']) assert.ok(args.includes(part));
  assert.ok(!args.join(' ').includes('17467')); assert.ok(!args.join(' ').includes('7468'));
  assert.throws(() => codexRelayArguments({ sshHost: '-unsafe' }));
});

test('one dedicated SSH child is supervised; duplicate launch cannot overwrite ownership or metadata', async t => {
  const { startWirelessRelay } = await api();
  const root = stateRoot(t); let starts = 0, options;
  const supervise = input => { starts++; options = input; return { async stop() {} }; };
  const job = startWirelessRelay({ root, relay: { sshHost: 'fixture-host' }, supervise, pollMs: 5 });
  t.after(() => job.stop());
  const metaBefore = readFileSync(join(root, 'wireless-relay.json'), 'utf8');
  assert.throws(() => startWirelessRelay({ root, relay: { sshHost: 'fixture-host' }, supervise }));
  assert.equal(starts, 1); assert.equal(options.command, 'ssh.exe');
  assert.equal(readFileSync(join(root, 'wireless-relay.json'), 'utf8'), metaBefore);
  options.onEvent({ type: 'restarting', delayMs: 1000, stderr: 'private child output', sshHost: 'fixture-host' });
  const metadata = readFileSync(join(root, 'wireless-relay.json'), 'utf8');
  assert.ok(!metadata.includes('private child output')); assert.ok(!metadata.includes('fixture-host'));
  await job.stop();
  assert.equal(existsSync(join(root, 'wireless-relay.lock')), false);
  assert.equal(JSON.parse(readFileSync(join(root, 'wireless-relay.json'), 'utf8')).status, 'stopped');
});

test('graceful stop keeps ownership until its own SSH child has exited and is idempotent', async t => {
  const { startWirelessRelay } = await api();
  const root = stateRoot(t); let closeChild, stops = 0;
  const childClosed = new Promise(resolve => { closeChild = resolve; });
  const job = startWirelessRelay({ root, relay: { sshHost: 'fixture-host' },
    supervise: () => ({ stop() { stops++; return childClosed; } }) });
  t.after(() => { closeChild(); return job.stop(); });
  const first = job.stop(), second = job.stop();
  assert.equal(first, second); assert.equal(stops, 1);
  assert.equal(existsSync(join(root, 'wireless-relay.lock')), true);
  closeChild(); await first; await job.done;
  assert.equal(existsSync(join(root, 'wireless-relay.lock')), false);
});

test('Windows stop request targets the exact relay identity and cleans its request and lock', async t => {
  const { startWirelessRelay, stopWirelessRelay } = await api();
  const root = stateRoot(t); let stops = 0;
  const job = startWirelessRelay({ root, relay: { sshHost: 'fixture-host' }, pollMs: 5,
    supervise: () => ({ async stop() { stops++; } }) });
  t.after(() => job.stop());
  const lock = JSON.parse(readFileSync(join(root, 'wireless-relay.lock'), 'utf8'));
  writeFileSync(join(root, 'wireless-relay.stop'), JSON.stringify({ ...lock, identity: 'foreign-instance' }));
  await sleep(25); assert.equal(stops, 0);
  await stopWirelessRelay(root, { timeoutMs: 1000 }); await job.done;
  assert.equal(stops, 1);
  assert.equal(existsSync(join(root, 'wireless-relay.stop')), false);
  assert.equal(existsSync(join(root, 'wireless-relay.lock')), false);
  assert.equal(await stopWirelessRelay(root), false);
});
