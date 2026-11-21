import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequestHandler } from '../bridge/http.mjs';
import { createHandler } from '../experiments/codex-direct/http.mjs';

test('Paseo forwards definite target ownership rejection in the glasses stream', async () => {
  const message = '本次未发送：该对话正由其他客户端占用。请在原客户端处理，或选择其他对话。';
  const server = createServer(createRequestHandler({ token: 'a'.repeat(64), gateway: {
    async submit() { throw Object.assign(Error(message), { code: 'AGENT_TARGET_IN_USE' }); },
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'idempotency-key': 'one' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'test' }] }),
    });
    const frames = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(frames.at(-1).type, 'done'); assert.equal(frames.at(-1).text, message);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('both HTTP backends describe permission, timeout and uncertain results with the same meaning', async t => {
  for (const status of ['permission', 'timeout', 'unknown', 'error']) {
    const answers = [];
    for (const create of [createRequestHandler, createHandler]) {
      const server = createServer(create({ token: 'a'.repeat(64), gateway: {
        async submit() { return { requestId: 'one', status, text: null }; },
      } }));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
          method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'idempotency-key': 'one' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
        });
        assert.equal(response.status, 200); answers.push((await response.json()).choices[0].message.content);
      } finally { await new Promise(resolve => server.close(resolve)); }
    }
    assert.equal(answers[0], answers[1]);
    assert.doesNotMatch(answers[0], /Paseo|Codex|实验/);
    if (status === 'timeout') assert.match(answers[0], /任务可能仍在执行.*不要重复发送/);
    if (status === 'permission') assert.match(answers[0], /等待授权.*原客户端/);
  }
});

test('shared help advertises actual capabilities and distinguishes local cancel from stopping a task', async () => {
  const api = await import('../bridge/assistant-messages.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
  assert.equal(typeof api.assistantHelp, 'function');
  const help = api.assistantHelp({ search: true, creation: true, shortcuts: true });
  for (const command of ['当前模式', '当前项目', '当前 Agent', '最近对话', '查找对话', '新建对话', '选择 1', '上一页', '下一页', '确认发送']) assert.ok(help.includes(command));
  assert.match(help, /已发送任务不会因此停止/);
  const limited = api.assistantHelp({ search: false, creation: false, shortcuts: false });
  assert.doesNotMatch(limited, /查找对话|新建对话|快捷短语/);
});
