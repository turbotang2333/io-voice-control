import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./wake.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
test('queue wake uses only a validated native ID, never launches a closed desktop, and throttles repeated wakeups', async () => {
  assert.equal(typeof api.createDesktopWake, 'function');
  const calls = []; let available = true, time = 0;
  const wake = api.createDesktopWake({ isAvailable: () => available, now: () => time,
    launch: async uri => { calls.push(uri); } });
  const id = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(wake.run('invalid&command'), { code: 'INVALID_TARGET' });
  await wake.run(id); await wake.run(id);
  assert.deepEqual(calls, ['codex://threads/wake/11111111-1111-4111-8111-111111111111']);
  time = 5001; await wake.run(id); assert.equal(calls.length, 2);
  available = false; time = 10002;
  await assert.rejects(wake.run(id), { code: 'DESKTOP_UNAVAILABLE' }); assert.equal(calls.length, 2);
});
