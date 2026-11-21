import { createHash } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });

function observeTurn(handle, agentId, requestId, notify) {
  if (!handle.timeline?.subscribe) return null;
  let ownTurn = null, seen = false, stopped = false, armed = false, competingInput = false, lastText = '';
  let expectedReload = false, reloadObserved = false;
  let firstMessageKey, firstText = '', previewTimer, firstMessageClosed = false;
  const seenFragments = new Set();
  const emit = update => { try { notify?.(update); } catch { /* UI progress must not fail the turn. */ } };
  const clearPreviewTimer = () => { if (previewTimer) clearTimeout(previewTimer); previewTimer = undefined; };
  const flushFirstMessage = () => {
    clearPreviewTimer();
    if (!stopped && seen && firstText.trim() && firstText !== lastText) {
      lastText = firstText;
      emit({ type: 'text', text: firstText });
    }
  };
  const subscription = handle.timeline.subscribe(update => {
    if (stopped || update?.agentId !== agentId) return;
    if (update.event?.type === 'replacement' || update.event?.type === 'subscription_restored' || update.event?.type === 'error') {
      // Official Paseo send may load a dormant conversation. Accept its one initial epoch change,
      // never a reconnect, foreign input, or replacement after our input has been observed.
      if (update.event.type === 'replacement' && armed && expectedReload && !reloadObserved && !seen && !competingInput) {
        reloadObserved = true; return;
      }
      stopped = true; clearPreviewTimer(); return;
    }
    if (!armed) {
      if (update.event?.type === 'timeline' && update.event.item?.type === 'user_message') competingInput = true;
      return;
    }
    if (update.event?.type !== 'timeline') return;
    const { item, turnId } = update.event;
    if (item?.type === 'user_message') {
      if (item.messageId === requestId || item.clientMessageId === requestId) {
        seen = true; ownTurn = turnId ?? null;
        emit({ type: 'state', state: 'working' });
      } else { stopped = true; clearPreviewTimer(); }
      return;
    }
    if (!seen || (ownTurn && turnId !== ownTurn)) return;
    if (item?.type === 'tool_call') {
      if (item.status === 'running') {
        flushFirstMessage();
        if (firstMessageKey !== undefined) firstMessageClosed = true;
        emit({ type: 'state', state: 'tool' });
      }
      return;
    }
    if (firstMessageClosed || item?.type !== 'assistant_message' || typeof item.text !== 'string' || !item.text) return;
    const key = item.messageId ?? firstMessageKey ?? 'first-unkeyed-message';
    if (firstMessageKey === undefined) firstMessageKey = key;
    if (key !== firstMessageKey) return;
    if (update.seq !== undefined) {
      if (seenFragments.has(update.seq)) return;
      seenFragments.add(update.seq);
    }
    // Live timeline events carry new fragments, not cumulative snapshots.
    // Keep identical fragments and whitespace too; deduplicate only event IDs.
    firstText += item.text;
    clearPreviewTimer();
    previewTimer = setTimeout(flushFirstMessage, /[。！？.!?…]$/u.test(firstText.trim()) ? 250 : 700);
  });
  return {
    ready: subscription.ready,
    canSubmit: () => !competingInput,
    trackingAvailable: () => !stopped,
    arm(expectReload = false) { armed = true; expectedReload = expectReload; },
    hasObservedInput: () => seen,
    currentTurn: () => seen && !stopped ? ownTurn : null,
    async release() {
      stopped = true;
      clearPreviewTimer();
      if (typeof subscription.release === 'function') await subscription.release();
      else if (typeof subscription === 'function') await subscription();
    },
  };
}

export function createTurnGateway(client, { agentId, workspaceId, timeoutMs = 300000, pollMs = 750,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!agentId || !workspaceId) throw fail('INVALID_INPUT', '必须明确指定 Agent 和工作区。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw fail('INVALID_INPUT', '等待时限无效。');
  const requests = new Map();
  let active = false;
  return {
    async submit({ requestId, text, onUpdate, assertCurrent } = {}) {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
          typeof text !== 'string' || !text.trim() || [...text].length > 4096) {
        throw fail('INVALID_INPUT', '请求编号或问题格式不正确。');
      }
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = requests.get(requestId);
      if (previous) {
        if (previous.hash !== hash) throw fail('REQUEST_CONFLICT', '同一请求编号不能用于不同问题。');
        return previous.promise;
      }
      if (active) throw fail('AGENT_BUSY', '已有请求执行中，请等待并查看原会话。');
      if (requests.size >= 128) throw fail('SESSION_FULL', '本轮验证请求已满，请先核对任务状态。');
      active = true;
      let expired = false, timer;
      const deadline = now() + timeoutMs;
      const timedOut = () => ({ requestId, agentId, status: 'timeout', text: null });
      const checkTime = () => {
        if (timeoutMs > 0 && (expired || now() >= deadline)) { expired = true; throw fail('REQUEST_DEADLINE', '等待超时。'); }
      };
      const notify = update => { if (!expired && (timeoutMs === 0 || now() < deadline)) try { onUpdate?.(update); } catch { /* Display only. */ } };
      const work = (async () => {
        try {
          checkTime();
          const handle = client.agents.ref(agentId);
          const refreshed = await handle.refresh(); checkTime();
          const snapshot = refreshed?.agent;
          if (!snapshot) throw fail('AGENT_NOT_FOUND', '指定 Agent 不存在。');
          if (snapshot.id !== agentId || snapshot.workspaceId !== workspaceId) throw fail('WRONG_WORKSPACE', 'Agent 或工作区已变化。');
          if (snapshot.pendingPermissions?.length) throw fail('AGENT_NEEDS_PERMISSION', 'Agent 正等待你在 Paseo 中授权。');
          if (!['idle', 'error', 'closed'].includes(snapshot.status) || snapshot.activeTurn || snapshot.archivedAt) throw fail('AGENT_BUSY', 'Agent 当前不能接收测试消息。');
          // SDK 0.13 has no atomic "send only if idle" option. This preflight is
          // best effort across other clients; steer prevents a race from interrupting them.
          let result, subscription;
          try {
            try {
              subscription = observeTurn(handle, agentId, requestId, notify);
              if (subscription) await subscription.ready;
              checkTime();
            } catch {
              try { await subscription?.release?.(); } catch { /* No send is allowed without tracking. */ }
              subscription = null;
            }
            if (!subscription) throw fail('AGENT_TRACKING_UNAVAILABLE', '无法建立任务跟踪，本次未提交；请检查电脑连接。');
            // Close the refresh-to-subscription window before sending. Events during readiness also fence this send.
            const latest = (await handle.refresh())?.agent; checkTime();
            if (!subscription.trackingAvailable()) throw fail('AGENT_TRACKING_UNAVAILABLE', '任务跟踪已中断，本次未提交；请检查电脑连接。');
            if (!latest || latest.id !== agentId || latest.workspaceId !== workspaceId) throw fail('WRONG_WORKSPACE', 'Agent 或工作区已变化，本次未提交。');
            if (latest.pendingPermissions?.length) throw fail('AGENT_NEEDS_PERMISSION', 'Agent 正等待你在 Paseo 中授权。');
            if (!subscription.canSubmit() || !['idle', 'error', 'closed'].includes(latest.status) || latest.activeTurn || latest.archivedAt) {
              throw fail('AGENT_BUSY', 'Agent 正在执行，本次未提交；请等待完成并查看原会话。');
            }
            // A failed pre-send fence is definite non-delivery, outside the unknown run catch.
            assertCurrent?.();
            checkTime();
            subscription.arm(latest.status === 'closed');
            try {
              result = await handle.run(text, { messageId: requestId, activeTurnBehavior: 'steer', timeoutMs: timeoutMs === 0 ? 0 : Math.max(1, deadline - now()) });
              checkTime();
              if (!subscription.currentTurn() || result.final?.activeTurn && result.final.activeTurn.turnId !== subscription.currentTurn()) {
                return { requestId, agentId, status: 'unknown', text: null };
              }
              if (result.status === 'permission') {
                const turnId = subscription?.currentTurn();
                const owned = value => value?.final?.id === agentId && value.final.workspaceId === workspaceId
                  && subscription?.currentTurn() === turnId
                  && (!value.final.activeTurn || value.final.activeTurn.turnId === turnId);
                // A permission flag alone is not enough to follow another client's task.
                if (!turnId || result.final?.activeTurn?.turnId !== turnId || !owned(result)
                  || typeof handle.waitForFinish !== 'function') return { requestId, agentId, status: 'unknown', text: null };
                notify({ type: 'state', state: 'permission' });
                while (result.status === 'permission') {
                  if (!owned(result)) return { requestId, agentId, status: 'unknown', text: null };
                  const remaining = deadline - now();
                  if (remaining <= 0) { result = { ...result, status: 'timeout', lastMessage: null }; break; }
                  await sleep(Math.min(pollMs, remaining));
                  if (!owned(result)) return { requestId, agentId, status: 'unknown', text: null };
                  const waitMs = deadline - now();
                  if (waitMs <= 0) { result = { ...result, status: 'timeout', lastMessage: null }; break; }
                  // Read-only continuation. Never send again or answer an authorization request.
                  result = await handle.waitForFinish(waitMs);
                  checkTime();
                  if (!owned(result)) return { requestId, agentId, status: 'unknown', text: null };
                }
              }
            }
            catch (error) {
              // SDK run() sends first, then waits. This native resume rejection occurs
              // before sendAgentMessage accepts input. Never infer non-delivery from
              // transport errors or after our input has been observed, even if tracking resets.
              if (!expired && !subscription.hasObservedInput()
                && /^Failed to resume Codex thread ([0-9a-f-]{36}): thread \1 already has an active writer(?:$|:)/i.test(error?.message ?? '')) {
                throw fail('AGENT_TARGET_IN_USE', '本次未发送：该对话正由其他客户端占用。请在原客户端处理，或选择其他对话。');
              }
              return expired ? timedOut() : { requestId, agentId, status: 'unknown', text: null };
            }
          } finally {
            if (subscription) try { await (subscription.release?.() ?? subscription()); } catch { /* Preserve the turn result. */ }
          }
          if (result.final?.id !== agentId || !['idle', 'error', 'permission', 'timeout'].includes(result.status)) {
            return { requestId, agentId, status: 'unknown', text: null };
          }
          return {
            requestId, agentId, status: result.status,
            text: result.status === 'idle' && typeof result.lastMessage === 'string' ? result.lastMessage : null,
          };
        } catch (e) { if (expired) return timedOut(); throw e; }
        finally { active = false; }
      })();
      const limit = timeoutMs > 0 ? new Promise(resolve => { timer = setTimeout(() => {
        expired = true; resolve(timedOut());
      }, Math.max(0, deadline - now())); }) : work;
      // Waiting ends at the deadline; in-flight SDK work retains the busy guard until it settles.
      const promise = Promise.race([work, limit]).finally(() => clearTimeout(timer));
      // Keep uncertain outcomes too: a network error is not permission to submit again.
      requests.set(requestId, { hash, promise });
      return promise;
    },
  };
}
