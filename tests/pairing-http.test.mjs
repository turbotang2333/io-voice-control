import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPairingStore } from '../bridge/pairing.mjs';
import { createRequestHandler } from '../bridge/http.mjs';
import { createHandler } from '../experiments/codex-direct/http.mjs';

for (const [name, create] of [['paseo', createRequestHandler], ['codex', createHandler]]) {
  test(`${name} pairing requires an unused proof, bypasses no assistant authentication, and sends no task`, async () => {
    const parent = join(homedir(), '.local/state/rayneo-paseo/test-artifacts/pairing-http'); mkdirSync(parent, { recursive: true });
    const pairing = createPairingStore({ directory: mkdtempSync(join(parent, 'fixture-')) });
    const profile = { endpoint: 'https://example.test/trial', port: 7468, token: 'b'.repeat(64) };
    const ticket = pairing.issue({ computerLabel: '测试电脑', profiles: { paseo: profile }, publicBaseUrl: profile.endpoint });
    const code = new URL(ticket.url).hash.slice('#rayneo_pair='.length);
    let tasks = 0;
    const server = createServer(create({ token: 'a'.repeat(64), pairing, gateway: { submit() { tasks++; throw Error('unexpected task'); } } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const claim = (value, headers = {}) => fetch(url + '/v1/pairing/claim', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, code: value }) });
    try {
      const page = await fetch(url + '/pair'); assert.equal(page.status, 200); assert.ok(!(await page.text()).includes(profile.token));
      assert.equal((await fetch(url + '/healthz')).status, 401);
      assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await claim(code, { origin: 'https://foreign.example' })).status, 403);
      assert.equal((await claim('x'.repeat(43))).status, 401);
      const success = await claim(code); assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await success.json()).profiles, { paseo: profile });
      assert.equal((await claim(code)).status, 401); assert.equal(tasks, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
