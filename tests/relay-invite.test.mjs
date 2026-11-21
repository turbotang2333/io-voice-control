import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInviteStore } from '../relay/invite-store.mjs';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function fixture() {
  const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/invite');
  mkdirSync(parent, { recursive: true });
  return join(mkdtempSync(join(parent, 'case-')), 'invites.sqlite');
}
const identity = 'a'.repeat(64), other = 'b'.repeat(64);

test('a code binds to one installation and may be retried by that installation', async () => {
  const path = fixture(), store = await createInviteStore({ path, now: () => 1000 });
  const code = store.issue();
  assert.equal(store.claim(code, identity), true);
  assert.equal(store.claim(code, identity), true);
  assert.equal(store.claim(code, other), false);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(code)), false);
  const restarted = await createInviteStore({ path, now: () => 1001 });
  assert.equal(restarted.claim(code, other), false);
  assert.equal(restarted.claim(code, identity), true);
  restarted.close();
});

test('expired or revoked codes cannot be newly claimed', async () => {
  let time = 1000;
  const store = await createInviteStore({ path: fixture(), now: () => time });
  const expired = store.issue({ ttlMs: 1000 }), revoked = store.issue();
  assert.equal(store.revoke(revoked), true);
  time += 1000;
  assert.equal(store.claim(expired, identity), false);
  assert.equal(store.claim(revoked, identity), false);
  assert.equal(store.claim('not-a-code', identity), false);
  store.close();
});

test('a completed binding can retry after expiry but revocation blocks all use', async () => {
  let time = 1000;
  const store = await createInviteStore({ path: fixture(), now: () => time });
  const code = store.issue({ ttlMs: 1000 });
  assert.equal(store.claim(code, identity), true);
  time += 1000;
  assert.equal(store.claim(code, identity), true);
  assert.equal(store.revoke(code), true);
  assert.equal(store.claim(code, identity), false);
  store.close();
});

test('simultaneous claims from different processes allow only one installation', async () => {
  const path = fixture(), store = await createInviteStore({ path });
  const code = store.issue(); store.close();
  const moduleUrl = pathToFileURL(resolve('relay/invite-store.mjs')).href;
  const script = `import {createInviteStore} from ${JSON.stringify(moduleUrl)}; const s=await createInviteStore({path:process.argv[1]}); process.stdout.write(String(s.claim(process.argv[2],process.argv[3]))); s.close();`;
  const run = binding => new Promise((accept, reject) => execFile(process.execPath, ['--input-type=module', '-e', script, path, code, binding],
    { encoding: 'utf8', windowsHide: true }, (error, stdout) => error ? reject(error) : accept(stdout)));
  const results = await Promise.all([run(identity), run(other)]);
  assert.deepEqual(results.sort(), ['false', 'true']);
});
