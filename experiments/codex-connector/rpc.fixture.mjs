import { createInterface } from 'node:readline';
const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
let createdName;
lines.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'thread/read' && mode === 'exit') return process.exit(0);
  if (request.method === 'thread/read' && mode === 'malformed') return process.stdout.write('invalid-json\n');
  const id = request.params.threadId;
  const responses = {
    initialize: {}, 'account/read': { account: { type: 'chatgpt' } },
    'thread/loaded/list': { data: [] },
    'thread/read': { thread: { id, ...(mode === 'activity' ? { path: process.argv[3] } : {}), ...(id === 'new-thread' ? { name: createdName, cwd: 'C:\\project', projectId: 'project-1' } : {}), status: ['approval', 'input-wait', 'finished', 'other-turn'].includes(mode)
      ? { type: 'active', activeFlags: [mode === 'input-wait' ? 'waitingOnUserInput' : 'waitingOnApproval'] } : { type: 'notLoaded' } } },
    'thread/start': { thread: { id: 'new-thread', projectId: request.params.projectId, cwd: request.params.cwd } },
    'thread/name/set': {},
    'thread/turns/list': { data: [{ id: mode === 'other-turn' ? 'another' : 'turn-1', status: ['approval', 'not-loaded', 'input-wait', 'other-turn'].includes(mode) ? 'inProgress' : 'completed', items: [
      { type: 'userMessage', clientId: 'private-client', startedAtMs: 1234, content: [{ type: 'text', text: 'must-not-expose' }] },
      { type: 'agentMessage', text: 'must-not-expose' },
    ] }], nextCursor: null },
    'thread/queue/list': { data: [], nextCursor: null },
    'thread/queue/add': { queuedSubmission: { id: 'queue-1', clientUserMessageId: request.params.clientUserMessageId } },
    'project/list': { data: [{ id: 'project-1', name: '正式项目', roots: [{ path: 'C:\\project' }] }], nextCursor: null },
    'thread/list': { data: [{ id: 'catalog-thread', name: '原对话', projectId: 'project-1', cwd: 'C:\\project', preview: 'must-not-expose' }], nextCursor: null },
  };
  if (request.method === 'thread/name/set') createdName = request.params.name;
  process.stdout.write(JSON.stringify({ id: request.id, result: responses[request.method] }) + '\n');
});
