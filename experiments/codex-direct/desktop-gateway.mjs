import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });

export function desktopTurnInput(turn, callerThreadId) {
  const inputs = (turn?.items ?? []).filter(i => i.type === 'userMessage'
    || (i.type === 'functionCallOutput' && i.name === 'send_message_to_thread' && i.namespace === 'codex_app'));
  if (inputs.length !== 1) return null;
  const item = inputs[0];
  if (item.type === 'userMessage') return (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!callerThreadId || item.output?.truncated !== false || typeof item.output.text !== 'string') return null;
  // Match the complete native transfer envelope; never accept text from a different caller.
  const match = item.output.text.match(/^<codex_delegation>\s*<source_thread_id>([^<>]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/u);
  return match?.[1] === callerThreadId ? match[2].trim() : null;
}

// Deliberately fixed to one human-authorized desktop test thread for this spike.
export function createDesktopGateway(client, { state, target, timeoutMs = 180000 }) {
  if (!target.threadId || client.authorizedThreadId !== target.threadId
      || (state.data.threadId && state.data.threadId !== target.threadId)) throw fail('WRONG_THREAD');
  state.data.threadId = target.threadId; state.save();
  let busy = false, uncertain = state.data.requests.some(r => r.status === 'unknown');
  const cache = new Map();
  const args = { threadId: target.threadId, hostId: target.hostId };
  const read = (includeOutputs = false) => client.call('read_thread', { ...args, turnLimit: 2,
    includeOutputs, maxOutputCharsPerItem: includeOutputs ? 6000 : 0 });
  const notify = (callback, update) => { try { callback?.(update); } catch { /* Display loss must not resubmit. */ } };
  return {
    async submit({ requestId, text, onUpdate, assertCurrent } = {}) {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
          || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      text = text.trim();
      const control = text.normalize('NFKC').replace(/\s+/gu, '').replace(/[。！？.!?]+$/u, '');
      if (/^(当前项目|列出项目|项目列表)$/u.test(control)) return { requestId, status: 'control', text: '当前是 Codex 桌面共用测试，连接桌面正在使用的原会话。' };
      if (/^(当前Agent|当前会话|列出Agent|列出会话|Agent列表|选择第?[1一](?:个|项|号)?|下一页|上一页)$/iu.test(control)) {
        return { requestId, status: 'control', text: `本轮固定使用桌面对话：${target.title ?? '眼镜桌面共用测试'}。可以直接对话。` };
      }
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = state.data.requests.find(r => r.id === requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT');
        return cache.get(requestId) ?? { requestId, status: 'unknown', text: null };
      }
      if (uncertain) throw fail('OUTCOME_UNKNOWN');
      if (busy) throw fail('CODEX_BUSY');
      if (state.data.requests.length >= 256) throw fail('EXPERIMENT_FULL');
      busy = true;
      let record, sent = false;
      try {
        const before = await read();
        if (before.thread?.id !== target.threadId) throw fail('WRONG_THREAD');
        if (before.thread.status?.type !== 'idle') throw fail('CODEX_BUSY');
        const beforeTurn = before.turns?.[0]?.id;
        assertCurrent?.();
        record = { id: requestId, hash, status: 'unknown', threadId: target.threadId };
        state.data.requests.push(record);
        try { state.save(); } catch { state.data.requests.pop(); throw fail('STATE_WRITE_FAILED'); }
        // Commit uncertainty before the only dispatch; never retry this call.
        sent = true;
        const receipt = await client.call('send_message_to_thread', { ...args, prompt: text });
        if (receipt.threadId !== target.threadId) throw fail('WRONG_THREAD');
        notify(onUpdate, { type: 'state', state: 'working' });
        const deadline = Date.now() + timeoutMs;
        let knownTurn;
        while (Date.now() < deadline) {
          // The installed desktop rejects wait_threads for newly created project tasks.
          // Read the same desktop's bounded turn view instead; never resend to recover it.
          const after = await read(true);
          if (after.thread?.id !== target.threadId) throw fail('WRONG_THREAD');
          const turn = after.turns?.[0];
          if (turn?.id && turn.id !== beforeTurn) {
            if (knownTurn && knownTurn !== turn.id) throw fail('DESKTOP_INTERLEAVED');
            knownTurn = turn.id;
            record.turnId = turn.id;
            if (turn.status === 'completed') {
              const userText = desktopTurnInput(turn, client.callerThreadId);
              const answer = turn.items?.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer').at(-1);
              if (after.thread?.id !== target.threadId || after.turns?.[0]?.id !== turn.id || userText !== text
                  || typeof answer?.text !== 'string' || !answer.text.trim()) throw fail('DESKTOP_INTERLEAVED');
              record.status = 'idle'; state.save();
              const result = { requestId, status: 'idle', text: answer.text };
              cache.set(requestId, result);
              notify(onUpdate, { type: 'text', text: answer.text });
              return result;
            }
            if (turn.status === 'failed' || turn.status === 'interrupted') throw fail('DESKTOP_TURN_FAILED');
          }
          if (after.thread.status?.type === 'systemError' || after.thread.status?.type === 'waitingOnApproval') {
            uncertain = true; state.save();
            return { requestId, status: 'permission', text: null };
          }
          await new Promise(resolve => setTimeout(resolve, 750));
        }
        uncertain = true; state.save();
        return { requestId, status: 'timeout', text: null };
      } catch (error) {
        if (!sent) throw error;
        uncertain = true;
        if (['WRONG_THREAD', 'DESKTOP_INTERLEAVED', 'DESKTOP_WAIT_FAILED', 'DESKTOP_TURN_FAILED',
          'DESKTOP_RESULT_UNKNOWN', 'DESKTOP_TOOL_REJECTED', 'DESKTOP_MCP_REJECTED', 'DESKTOP_DISCONNECTED'].includes(error.code)) record.failureCode = error.code;
        try { state.save(); } catch { /* Persisted pre-dispatch unknown remains authoritative. */ }
        return { requestId, status: 'unknown', text: null };
      } finally { busy = false; }
    },
  };
}
