import { createHash, randomUUID } from 'node:crypto';
import { validId } from './journal.mjs';
import { createReplyText } from './reply-text.mjs';
import { assistantMessages as messages } from '../../bridge/assistant-messages.mjs';

const fail = code => Object.assign(new Error(code), { code });
const fingerprint = text => createHash('sha256').update(text).digest('hex');
const inputText = item => (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
const unresolvedTurn = turn => turn.status === 'inProgress'
  || (turn.status === 'interrupted' && !Number.isFinite(turn.completedAt));
const notify = (fn, update) => { try { fn?.(update); } catch {} };
const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']);
// Read only native lifecycle metadata. Text mentioning tools or permissions is never a signal.
// This is a saved phase record, not an authoritative desktop runtime/approval state.
const hasOpenToolRecord = item => validId(item?.id) && !['completed', 'failed', 'declined', 'interrupted', 'cancelled'].includes(item.status)
  && (toolTypes.has(item.type) ? item.status === 'inProgress'
  && !Number.isFinite(item.completedAtMs) : ['sleep', 'webSearch', 'imageGeneration'].includes(item.type)
    && Number.isFinite(item.startedAtMs) && !Number.isFinite(item.completedAtMs));
function reportProgress(progress, onUpdate, state) {
  progress.states ??= new Set();
  if (progress.states.has(state)) return;
  progress.states.add(state); notify(onUpdate, { type: 'state', state });
}

// Queue into the existing writer; never resume, start a turn, or take its lock.
export function createQueueGateway(client, { journal, timeoutMs = 300000, pollMs = 750,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), validateSnapshot = () => true, wakeQueued = async () => {} }) {
  if (client.threadId !== journal.threadId) throw fail('JOURNAL_TARGET_MISMATCH');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw fail('INVALID_INPUT');
  let busy = false;
  const result = (id, status, text = messages[status] ?? null) => ({ requestId: id, status, text });
  async function observe(id, record, onUpdate, progress = { reply: createReplyText(), emitted: '' }) {
    const turns = await client.turns();
    progress.assertCurrent?.();
    let preview, activeTool = false, approval = false;
    const matches = turns.filter(t => t.items?.some(i => i.type === 'userMessage' && i.clientId === record.clientId));
    if (matches.length > 1) throw fail('REPLY_AMBIGUOUS');
    const turn = matches[0];
    if (!turn && record.status === 'idle') {
      return result(id, 'idle', '此请求此前已完成，请在 Codex 原对话查看回复。');
    }
    if (!turn && record.status === 'failed') return result(id, 'failed');
    if (turn) {
      const users = turn.items.filter(i => i.type === 'userMessage');
      if (users.length !== 1 || fingerprint(inputText(users[0])) !== record.hash) throw fail('REPLY_AMBIGUOUS');
      if (record.turnId && record.turnId !== turn.id) throw fail('REPLY_AMBIGUOUS');
      record.turnId = turn.id;
      if (turn.status === 'completed') {
        const final = turn.items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer').at(-1);
        if (typeof final?.text !== 'string' || !final.text.trim()) throw fail('REPLY_INCOMPLETE');
        const answer = progress.reply.finish(turn);
        record.status = 'idle'; journal.put(id, record);
        if (answer !== progress.emitted) notify(onUpdate, { type: 'text', text: answer });
        return result(id, 'idle', answer);
      }
      // An unloaded app-server reader normalizes a live, incompletely persisted turn
      // to interrupted. Without a completion timestamp this is not a terminal result.
      const finishedInterruption = turn.status === 'interrupted' && Number.isFinite(turn.completedAt);
      record.status = turn.status === 'failed' || finishedInterruption ? 'failed' : 'working';
      if (record.status === 'working' && typeof onUpdate === 'function' && typeof client.approvalActivity === 'function') {
        try { approval = await client.approvalActivity(turn.id) === true; } catch { /* No reliable signal means no authorization claim. */ }
        progress.assertCurrent?.();
      }
      if (record.status === 'working' && typeof onUpdate === 'function') preview = progress.reply.preview(turn);
      activeTool = record.status === 'working' && turn.items.some(hasOpenToolRecord);
      if (record.status === 'working' && !activeTool && typeof onUpdate === 'function'
        && !progress.states?.has('tool') && typeof client.toolActivity === 'function') {
        try { activeTool = await client.toolActivity(turn.id) === true; } catch { /* Optional phase hint only. */ }
        progress.assertCurrent?.();
      }
    } else {
      const pending = await client.queued();
      progress.assertCurrent?.();
      const own = pending.filter(q => q.clientUserMessageId === record.clientId);
      if (own.length > 1) throw fail('REPLY_AMBIGUOUS');
      record.status = own.length ? 'queued' : 'unknown';
      if (own.length) record.queueId = own[0].id;
    }
    journal.put(id, record);
    if (record.status === 'working') reportProgress(progress, onUpdate, 'working');
    if (preview && preview !== progress.emitted) {
      notify(onUpdate, { type: 'text', text: preview }); progress.emitted = preview;
    }
    if (approval) reportProgress(progress, onUpdate, 'permission');
    else if (activeTool) reportProgress(progress, onUpdate, 'tool');
    if (record.status === 'queued') { try { await wakeQueued({ ...record }, progress.assertCurrent); } catch { /* A failed wake never resubmits the saved message. */ } }
    return result(id, record.status);
  }
  return {
    async reconcile(requestId) {
      if (!validId(requestId)) throw fail('INVALID_INPUT');
      const record = journal.get(requestId);
      if (!record) throw fail('INVALID_INPUT');
      if (busy) throw fail('CODEX_BUSY');
      busy = true;
      try { return await observe(requestId, record); }
      catch { return result(requestId, 'unknown'); }
      finally { busy = false; }
    },
    async submit({ requestId, text, onUpdate, assertCurrent } = {}) {
      if (!validId(requestId) || typeof text !== 'string' || !text.trim() || [...text].length > 4096) throw fail('INVALID_INPUT');
      text = text.trim();
      const hash = fingerprint(text), previous = journal.get(requestId);
      if (previous && previous.hash !== hash) throw fail('REQUEST_CONFLICT');
      if (busy) throw fail('CODEX_BUSY');
      busy = true;
      let record = previous, expired = false, timer;
      const deadline = now() + timeoutMs;
      const check = () => {
        if (timeoutMs > 0 && (expired || now() >= deadline)) { expired = true; throw fail('REQUEST_DEADLINE'); }
        assertCurrent?.();
      };
      const progress = () => ({ reply: createReplyText(), emitted: '', assertCurrent: check });
      const work = (async () => { try {
        check();
        if (!record) {
          if (journal.unresolved()) {
            for (const [id, pending] of journal.pending()) {
              try { await observe(id, pending, undefined, progress()); check(); } catch (e) { if (expired) throw e; throw fail('OUTCOME_UNKNOWN'); }
            }
            if (journal.unresolved()) throw fail('OUTCOME_UNKNOWN');
          }
          if (!client.isDesktopAvailable()) throw fail('DESKTOP_UNAVAILABLE');
          const snapshot = await client.snapshot(); check();
          if (snapshot.id !== client.threadId || !validateSnapshot(snapshot)) throw fail('INVALID_TARGET');
          const turns = await client.turns(); check();
          const queued = await client.queued(); check();
          if (turns.some(unresolvedTurn) || queued.length) throw fail('CODEX_BUSY');
          if (!client.isDesktopAvailable()) throw fail('DESKTOP_UNAVAILABLE');
          record = { hash, clientId: randomUUID(), status: 'unknown' };
          // Persist before dispatch. A crash, lost ack or failed response never replays.
          journal.put(requestId, record);
          try {
            check();
            const ack = await client.enqueue(text, record.clientId); check();
            if (!validId(ack?.id) || ack.clientUserMessageId !== record.clientId) throw fail('QUEUE_ACK_INVALID');
            record.queueId = ack.id; record.status = 'queued'; journal.put(requestId, record);
            try { await wakeQueued({ ...record }, check); } catch { /* Reconciliation can retry waking the same queue, never enqueue again. */ }
            check();
          } catch { return result(requestId, expired ? 'timeout' : 'unknown'); }
        }
        const state = progress();
        do {
          check();
          const value = await observe(requestId, record, update => {
            if (!expired && (timeoutMs === 0 || now() < deadline)) notify(onUpdate, update);
          }, state);
          check();
          if (['idle', 'failed'].includes(value.status) || timeoutMs === 0) return value;
          await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
        } while (true);
      } catch (e) {
        if (expired) return result(requestId, 'timeout');
        if (!record) throw e;
        return result(requestId, 'unknown');
      } finally { busy = false; } })();
      if (timeoutMs === 0) return work;
      // A slow native RPC cannot extend lens waiting. Keep the ownership lock until that RPC settles.
      const limit = new Promise(resolve => { timer = setTimeout(() => {
        expired = true; resolve(result(requestId, 'timeout'));
      }, Math.max(0, deadline - now())); });
      try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
    },
  };
}
