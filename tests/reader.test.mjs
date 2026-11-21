import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../bridge/reader.mjs');

// Only the SDK boundary is replaced; the adapter's filtering and validation run for real.
function conversationClient({ missing = false, wrongAgent = false, error = null } = {}) {
  return {
    agents: {
      ref(id) {
        assert.equal(id, 'agent-one');
        return {
          async refresh() {
            return missing ? null : { agent: {
              id, status: 'idle', workspaceId: 'workspace-one', model: 'test-model',
              pendingPermissions: [{ requestId: 'private-permission', input: 'private-input' }],
              persistence: { private: 'not-for-output' },
            } };
          },
          timeline: {
            async refetch(options) {
              assert.deepEqual(options, { direction: 'before', limit: 4, projection: 'projected' });
              return {
                agentId: wrongAgent ? 'agent-two' : id, error, epoch: 'epoch-one',
                startCursor: { epoch: 'epoch-one', seq: 1 },
                endCursor: { epoch: 'epoch-one', seq: 5 }, hasOlder: true, hasNewer: false,
                entries: [
                  { seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: '问题甲' } },
                  { seqStart: 2, seqEnd: 2, item: { type: 'reasoning', text: 'private-reasoning' } },
                  { seqStart: 3, seqEnd: 3, item: { type: 'tool_call', output: 'private-tool-output' } },
                  { seqStart: 4, seqEnd: 5, item: { type: 'assistant_message', text: '回答甲' } },
                ],
              };
            },
          },
        };
      },
    },
  };
}

test('history exposes only user and assistant messages, preserving paging and identity', async () => {
  const { readConversation } = await load();
  const result = await readConversation(conversationClient(), { agentId: 'agent-one', limit: 4, includeText: true });
  assert.deepEqual(result.agent, {
    id: 'agent-one', workspaceId: 'workspace-one', status: 'idle', model: 'test-model', needsPermission: true,
  });
  assert.deepEqual(result.history.messages, [
    { role: 'user', seqStart: 1, seqEnd: 1, characters: 3, text: '问题甲' },
    { role: 'assistant', seqStart: 4, seqEnd: 5, characters: 3, text: '回答甲' },
  ]);
  assert.equal(result.history.fetchedEntries, 4);
  assert.equal(result.history.hasOlder, true);
  assert.equal(result.history.epoch, 'epoch-one');
  assert.deepEqual(result.history.endCursor, { epoch: 'epoch-one', seq: 5 });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test('default output contains lengths and roles without original conversation text', async () => {
  const { readConversation } = await load();
  const result = await readConversation(conversationClient(), { agentId: 'agent-one', limit: 4 });
  assert.equal(result.history.messages.length, 2);
  assert.equal(result.history.messages[0].characters, 3);
  assert.doesNotMatch(JSON.stringify(result), /问题甲|回答甲|private-/);
});

test('a missing agent fails explicitly instead of reading a different conversation', async () => {
  const { readConversation } = await load();
  await assert.rejects(readConversation(conversationClient({ missing: true }), {
    agentId: 'agent-one', limit: 4,
  }), { code: 'AGENT_NOT_FOUND' });
});

test('a mismatched history identity is rejected', async () => {
  const { readConversation } = await load();
  await assert.rejects(readConversation(conversationClient({ wrongAgent: true }), {
    agentId: 'agent-one', limit: 4,
  }), { code: 'IDENTITY_MISMATCH' });
});

test('a failed history request does not become an empty successful page or leak the server error', async () => {
  const { readConversation } = await load();
  await assert.rejects(readConversation(conversationClient({ error: 'private-server-error' }), {
    agentId: 'agent-one', limit: 4,
  }), error => error.code === 'HISTORY_FAILED' && !error.message.includes('private-server-error'));
});

test('invalid IDs and page sizes are rejected before accessing the SDK', async () => {
  const { readConversation } = await load();
  for (const input of [
    { agentId: '' }, { agentId: 'agent-one', limit: 0 },
    { agentId: 'agent-one', limit: 101 }, { agentId: 'agent-one', limit: 1.5 },
  ]) {
    await assert.rejects(readConversation({}, input), { code: 'INVALID_INPUT' });
  }
});

test('directory pagination returns only agents belonging to matched workspaces', async () => {
  const { readDirectory } = await load();
  const client = {
    workspaces: {
      async list({ filter, page }) {
        assert.equal(filter.query, 'glasses-project');
        assert.equal(page.limit, 50);
        if (!page.cursor) return { entries: [{ id: 'w1', projectId: 'p1', name: '眼镜', status: 'done', project: { projectKey: 'key1' } }], pageInfo: { nextCursor: 'next' } };
        assert.equal(page.cursor, 'next');
        return { entries: [{ id: 'w2', projectId: 'p1', name: '验证', status: 'running', project: { projectKey: 'key1' } }], pageInfo: { nextCursor: null } };
      },
    },
    agents: {
      async list({ filter }) {
        assert.deepEqual(filter.projectKeys, ['key1']);
        return { entries: [
          { agent: { id: 'a1', workspaceId: 'w1', title: '会话甲', status: 'idle' } },
          { agent: { id: 'a2', workspaceId: 'other', title: 'unrelated-private-title', status: 'idle' } },
          { agent: { id: 'a3', workspaceId: 'w2', title: '会话乙', status: 'running' } },
        ], pageInfo: { nextCursor: null } };
      },
    },
  };
  const result = await readDirectory(client, { query: 'glasses-project' });
  assert.deepEqual(result.workspaces.map(w => w.id), ['w1', 'w2']);
  assert.deepEqual(result.agents.map(a => a.id), ['a1', 'a3']);
  assert.doesNotMatch(JSON.stringify(result), /unrelated-private-title/);
});

test('an empty workspace search never requests an unscoped agent list', async () => {
  const { readDirectory } = await load();
  const result = await readDirectory({ workspaces: {
    async list() { return { entries: [], pageInfo: { nextCursor: null } }; },
  } }, { query: 'not-found' });
  assert.deepEqual(result, { workspaces: [], agents: [] });
});

test('repeated pagination cursors fail instead of looping forever', async () => {
  const { readDirectory } = await load();
  await assert.rejects(readDirectory({ workspaces: {
    async list() { return { entries: [], pageInfo: { nextCursor: 'same' } }; },
  } }, { query: 'glasses-project' }), { code: 'INVALID_PAGE' });
});

test('missing workspace scope fails rather than falling back to all agents', async () => {
  const { readDirectory } = await load();
  await assert.rejects(readDirectory({ workspaces: {
    async list() { return { entries: [{ id: 'w1' }], pageInfo: { nextCursor: null } }; },
  } }, { query: 'glasses-project' }), { code: 'MISSING_SCOPE' });
});
