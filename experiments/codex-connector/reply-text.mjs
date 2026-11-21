import { validId } from './journal.mjs';

const fail = () => Object.assign(new Error(), { code: 'REPLY_INCOMPLETE' });
const earlyPhases = new Set(['commentary', 'partial_answer']);
const notice = '\n完整回复请在原客户端查看。';
function cut(text, length) {
  const end = length > 0 && /[\uD800-\uDBFF]/u.test(text[length - 1]) ? length - 1 : length;
  return text.slice(0, end);
}

/** Per-request memory only. Only stable, user-facing assistant items become early snapshots. */
export function createReplyText() {
  let parts = new Map(), previewed = '';
  function collect(turn, complete) {
    const next = new Map(parts), seen = new Map();
    for (const [index, item] of turn.items.entries()) {
      if (item.type !== 'agentMessage' || !(earlyPhases.has(item.phase) || complete && item.phase === 'final_answer')) continue;
      // Earlier readers could return an id-less final item. It is terminal and already turn-bound;
      // no streamed identity is inferred from its positional key.
      const positional = complete && item.phase === 'final_answer' && item.id === undefined;
      const id = positional ? '#final-' + index : item.id;
      if ((!positional && !validId(id)) || typeof item.text !== 'string') throw fail();
      if (!item.text.trim()) continue;
      if (seen.has(id) && seen.get(id) !== item.text) throw fail();
      seen.set(id, item.text);
      const previous = next.get(id);
      if (previous !== undefined && !item.text.startsWith(previous)) {
        if (!complete && previous.startsWith(item.text)) continue; // Incomplete native snapshot, not a new delta.
        throw fail();
      }
      next.set(id, item.text);
    }
    const text = [...next.values()].join('\n\n');
    const output = !complete ? cut(text, Math.min(2048, text.length))
      : text.length <= 8192 ? text : cut(text, 8192 - notice.length) + notice;
    if (!output.startsWith(previewed)) throw fail();
    parts = next;
    if (!complete) previewed = output;
    return output;
  }
  return { preview: turn => collect(turn, false), finish: turn => collect(turn, true) };
}
