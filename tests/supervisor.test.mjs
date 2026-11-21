import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

test('explicit local-only Paseo startup ignores even an existing legacy relay configuration', async () => {
  const api = await import('../bridge/supervisor.mjs');
  assert.equal(typeof api.dailyMaintenancePlan, 'function');
  const profile = { version: 1, port: 7468, apiToken: 'a'.repeat(64) };
  const poisoned = { get enabled() { assert.fail('local-only must never inspect the legacy relay'); } };
  const plan = api.dailyMaintenancePlan(profile, poisoned, { localOnly: true });
  assert.equal(plan.relayEnabled, false); assert.equal(plan.relayArgs, null);
  assert.equal(plan.config.host, '127.0.0.1');
  const legacy = api.dailyMaintenancePlan(profile, { enabled: true, sshHost: 'fixture-host', remotePort: 28001 });
  assert.equal(legacy.relayEnabled, true); assert.ok(legacy.relayArgs.includes('127.0.0.1:28001:127.0.0.1:7468'));
});

test('SSH forwarding arguments bind both ends to loopback, fail closed and verify the host', async () => {
  const { relayArguments } = await import('../bridge/supervisor.mjs');
  assert.deepEqual(relayArguments({ sshHost: 'fixture-host', remotePort: 17467 }, 7467), [
    '-NT', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-R', '127.0.0.1:17467:127.0.0.1:7467', 'fixture-host',
  ]);
  for (const value of [{ sshHost: '-Funsafe', remotePort: 17467 }, { sshHost: 'host', remotePort: 22 }, { sshHost: 'user@host', remotePort: 17467 }]) {
    assert.throws(() => relayArguments(value, 7467));
  }
});

test('supervisor recovers a crashed child and stops its own child without any further restart', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const count = join(root, 'count'), worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const path=process.argv[2]; const n=existsSync(path)?Number(readFileSync(path,'utf8'))+1:1;
    writeFileSync(path,String(n)); if(n===1)process.exit(1); setInterval(()=>{},1000);`);
  const job = superviseCommand({ command: process.execPath, args: [worker, count], minDelayMs: 10, maxDelayMs: 30 });
  t.after(() => job.stop());
  const deadline = Date.now() + 5000;
  while ((!existsSync(count) || readFileSync(count, 'utf8') !== '2') && Date.now() < deadline) await sleep(15);
  assert.equal(readFileSync(count, 'utf8'), '2');
  await job.stop();
  await sleep(80);
  assert.equal(readFileSync(count, 'utf8'), '2');
});

test('manual relay recovery replaces only its own child once and can then stop cleanly', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-relay-restart-'));
  const count = join(root, 'count'), worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const path=process.argv[2]; writeFileSync(path,String(existsSync(path)?Number(readFileSync(path,'utf8'))+1:1)); setInterval(()=>{},1000);`);
  const job = superviseCommand({ command: process.execPath, args: [worker, count], minDelayMs: 10, maxDelayMs: 30 });
  t.after(async () => { await job.stop(); rmSync(root, { recursive: true, force: true }); });
  const waitFor = async expected => {
    const deadline = Date.now() + 5000;
    while ((!existsSync(count) || readFileSync(count, 'utf8') !== expected) && Date.now() < deadline) await sleep(15);
    assert.equal(readFileSync(count, 'utf8'), expected);
  };
  await waitFor('1');
  await Promise.all([job.restart(), job.restart()]);
  await waitFor('2');
  await sleep(80);
  assert.equal(readFileSync(count, 'utf8'), '2');
  await job.stop();
  assert.equal(await job.restart(), false);
  await sleep(80);
  assert.equal(readFileSync(count, 'utf8'), '2');
});

test('relay exit can delegate all restarts to the health budget instead of retrying forever', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const root = mkdtempSync(join(homedir(), '.local', 'state', 'rayneo-paseo', 'test-relay-budget-'));
  const count = join(root, 'count'), worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const path=process.argv[2];writeFileSync(path,String(existsSync(path)?Number(readFileSync(path,'utf8'))+1:1));process.exit(1);`);
  const job = superviseCommand({ command: process.execPath, args: [worker, count], minDelayMs: 10, maxDelayMs: 20, restartOnExit: false });
  t.after(async () => { await job.stop(); rmSync(root, { recursive: true, force: true }); });
  const waitFor = async expected => {
    const deadline = Date.now() + 5000;
    while ((!existsSync(count) || Number(readFileSync(count, 'utf8')) < expected) && Date.now() < deadline) await sleep(15);
    assert.equal(readFileSync(count, 'utf8'), String(expected));
  };
  await waitFor(1); await sleep(150);
  assert.equal(readFileSync(count, 'utf8'), '1');
  await job.restart(); await waitFor(2); await sleep(150);
  assert.equal(readFileSync(count, 'utf8'), '2');
});

test('relay exits record only classified diagnostics and expose stopped child state', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const events = [];
  const job = superviseCommand({ command: process.execPath,
    args: ['-e', 'process.stderr.write("Permission denied (publickey) private-fixture@example.invalid token=fixture-secret");process.exit(255)'],
    restartOnExit: false, diagnoseSsh: true, onEvent: event => events.push(event) });
  t.after(() => job.stop());
  const deadline = Date.now() + 5000;
  while (!events.some(e => e.type === 'exited') && Date.now() < deadline) await sleep(15);
  const exited = events.find(e => e.type === 'exited');
  assert.equal(exited?.reason, 'authentication_failed');
  assert.equal(exited?.exitCode, 255);
  assert.equal(exited?.intentional, false);
  assert.equal(job.getState().running, false);
  assert.equal(job.getState().lastExitReason, 'authentication_failed');
  assert.doesNotMatch(JSON.stringify(events), /example\.invalid|fixture-secret|Permission denied/);
});

test('a missing SSH executable records one classified exit and does not loop outside the health monitor', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const events = [];
  const job = superviseCommand({ command: join(homedir(), '.local/state/rayneo-paseo/nonexistent-ssh-fixture.exe'),
    restartOnExit: false, diagnoseSsh: true, onEvent: event => events.push(event) });
  t.after(() => job.stop());
  const deadline = Date.now() + 5000;
  while (!events.some(e => e.type === 'exited') && Date.now() < deadline) await sleep(15);
  await sleep(50);
  assert.equal(events.filter(e => e.type === 'exited').length, 1);
  assert.equal(job.getState().running, false);
  assert.equal(job.getState().lastExitReason, 'executable_missing');
});

test('health recovery restarts an actual exited relay child and then observes a healthy connection', async t => {
  const { superviseCommand } = await import('../bridge/supervisor.mjs');
  const { createRelayHealthMonitor } = await import('../bridge/relay-health.mjs');
  const root = mkdtempSync(join(homedir(), '.local/state/rayneo-paseo/test-relay-recovery-'));
  const count = join(root, 'count'), worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const p=process.argv[2],n=existsSync(p)?Number(readFileSync(p,'utf8'))+1:1;writeFileSync(p,String(n));
    if(n===1){process.stderr.write('Connection reset by peer');process.exit(255);}setInterval(()=>{},1000);`);
  const events = [];
  const job = superviseCommand({ command: process.execPath, args: [worker, count], restartOnExit: false,
    diagnoseSsh: true, onEvent: e => events.push(e) });
  const monitor = createRelayHealthMonitor({ probeLocal: async () => 'ready',
    probePublic: async () => existsSync(count) && readFileSync(count, 'utf8') === '2' ? 'ready' : 'unreachable',
    getRelayState: () => job.getState(), restartRelay: () => job.restart() });
  t.after(async () => { await monitor.stop(); await job.stop(); rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000;
  while (!events.some(e => e.type === 'exited') && Date.now() < deadline) await sleep(15);
  assert.equal(job.getState().lastExitReason, 'connection_lost');
  assert.equal((await monitor.check()).state, 'relay_recovering');
  while ((!existsSync(count) || readFileSync(count, 'utf8') !== '2') && Date.now() < deadline) await sleep(15);
  assert.equal(readFileSync(count, 'utf8'), '2');
  assert.equal((await monitor.check()).state, 'ready');
});
