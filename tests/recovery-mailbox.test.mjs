import assert from 'node:assert/strict';
import test from 'node:test';
import * as recovery from '../scripts/phone-recovery.mjs';

function phone(failure) {
  const files = new Map(), nonce = 'a'.repeat(64), root = '/app/maintenance';
  const call = args => {
    const [kind, command, ...rest] = args;
    if (kind === 'push') {
      files.set(args[2], JSON.stringify({ nonce, action: 'restore', key: 'test-key' }));
      if (failure === 'push') throw new Error('USB ended after file transfer');
      return '';
    }
    assert.equal(kind, 'shell');
    if (command === 'ls') return [...files.keys()].map(path => path.split('/').pop()).join('\n');
    if (command === 'mv') {
      const source = rest[1], target = rest[2];
      if (!files.has(target)) { files.set(target, files.get(source)); files.delete(source); }
      if (failure === 'publish') throw new Error('USB ended after rename');
      return '';
    }
    if (command === 'cat') { if (!files.has(rest[0])) throw new Error('missing'); return files.get(rest[0]); }
    if (command === 'rm') { for (const path of rest.slice(1)) files.delete(path); return ''; }
    throw new Error('unexpected command');
  };
  return { files, nonce, root, call };
}
for (const failure of ['push', 'publish']) test(`USB ${failure} uncertainty leaves no executable restore request after cleanup`, () => {
  const fake = phone(failure);
  assert.equal(typeof recovery.requestMailbox, 'function');
  const mailbox = recovery.requestMailbox(fake.call, fake.root, fake.nonce);
  assert.throws(() => mailbox.publish('private-request.json'));
  mailbox.cleanup();
  assert.deepEqual([...fake.files.keys()], []);
});
test('a pending operation from another request is never overwritten or removed', () => {
  const fake = phone();
  fake.files.set(fake.root + '/request.json', JSON.stringify({ nonce: 'b'.repeat(64) }));
  assert.equal(typeof recovery.requestMailbox, 'function');
  const mailbox = recovery.requestMailbox(fake.call, fake.root, fake.nonce);
  assert.throws(() => mailbox.publish('private-request.json'), { code: 'PENDING_PHONE_RECOVERY_REQUIRES_INSPECTION' });
  mailbox.cleanup();
  assert.equal(fake.files.size, 1);
});
test('publication exposes only a complete request and cleanup is scoped to its nonce', () => {
  const fake = phone();
  assert.equal(typeof recovery.requestMailbox, 'function');
  const mailbox = recovery.requestMailbox(fake.call, fake.root, fake.nonce);
  mailbox.publish('private-request.json');
  assert.deepEqual([...fake.files.keys()], [fake.root + '/request.json']);
  fake.files.set(fake.root + '/response.json', JSON.stringify({ nonce: fake.nonce, ok: true }));
  mailbox.cleanup(); assert.equal(fake.files.size, 0);
});

test('USB activation uses the launcher intent that brings an existing phone task to the foreground', () => {
  const calls = [];
  assert.equal(typeof recovery.launchRecoveryApp, 'function');
  recovery.launchRecoveryApp(args => { calls.push(args); return 'Status: ok'; });
  assert.deepEqual(calls, [['shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000', '-n',
    'com.rayneo.venus.pub/com.rayneo.venus.MainActivity']]);
});

test('maintenance waits for the home activity before bringing the app back', () => {
  const calls = [];
  assert.equal(typeof recovery.activateRecoveryApp, 'function');
  recovery.activateRecoveryApp(args => {
    calls.push(args);
    return args.includes('dumpsys') ? 'topResumedActivity=ActivityRecord{1 u0 com.example.launcher/.Home t1}' : 'Status: ok';
  });
  assert.deepEqual(calls[0], ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME']);
  assert.deepEqual(calls[1], ['shell', 'dumpsys', 'activity', 'activities']);
  assert.ok(calls[2].includes('android.intent.category.LAUNCHER'));
  assert.throws(() => recovery.activateRecoveryApp(args => args.includes('dumpsys')
    ? 'topResumedActivity=ActivityRecord{1 u0 com.rayneo.venus.pub/com.rayneo.venus.MainActivity t1}' : 'Status: ok'),
  { code: 'HOME_TRANSITION_NOT_COMPLETE' });
});

test('only explicit idle permission may restart the app, and it happens before publishing a request', () => {
  const events = [], call = args => events.push(args.join(' '));
  const mailbox = { publish: path => events.push('publish ' + path) };
  assert.equal(typeof recovery.submitRecoveryRequest, 'function');
  recovery.submitRecoveryRequest(call, mailbox, 'request.json');
  assert.deepEqual(events, ['publish request.json']);
  events.length = 0;
  recovery.submitRecoveryRequest(call, mailbox, 'request.json', { idleRestart: true });
  assert.deepEqual(events, ['shell am force-stop com.rayneo.venus.pub', 'publish request.json']);
  events.length = 0;
  assert.throws(() => recovery.submitRecoveryRequest(call, mailbox, 'request.json', { idleRestart: 'true' }));
  assert.deepEqual(events, []);
});
