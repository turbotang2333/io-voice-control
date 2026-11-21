import { openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { validId } from './journal.mjs';

const tailLimit = 1024 * 1024, headerLimit = 256 * 1024;
const plainPath = path => path.replace(/^\\\\\?\\/, '');
const childOf = (path, root) => path.toLowerCase().startsWith((root + sep).toLowerCase());
function readExactly(fd, bytes, position) {
  let read = 0;
  while (read < bytes.length) {
    const count = readSync(fd, bytes, read, bytes.length - read, position + read);
    if (count <= 0) return false;
    read += count;
  }
  return true;
}

// Optional, read-only phase hint. No chat, arguments, outputs or call IDs leave this function.
// A model's function_call status "completed" means the call packet is complete, not its execution.
export function readToolActivity({ codexHome, snapshotPath, threadId, turnId }) {
  let fd;
  try {
    if (!validId(threadId) || !validId(turnId) || typeof snapshotPath !== 'string') return false;
    const home = plainPath(realpathSync(codexHome)), path = plainPath(realpathSync(plainPath(snapshotPath)));
    if (!path.endsWith('.jsonl') || !['sessions', 'archived_sessions'].some(dir => childOf(path, resolve(home, dir)))) return false;
    fd = openSync(path, 'r'); const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const header = Buffer.alloc(Math.min(stat.size, headerLimit)); if (!readExactly(fd, header, 0)) return false;
    const firstEnd = header.indexOf(10); if (firstEnd < 0) return false;
    const first = JSON.parse(header.subarray(0, firstEnd).toString('utf8'));
    if (first.type !== 'session_meta' || first.payload?.id !== threadId
      || first.payload.session_id !== undefined && first.payload.session_id !== threadId) return false;
    const start = Math.max(0, stat.size - tailLimit), bytes = Buffer.alloc(stat.size - start);
    if (!readExactly(fd, bytes, start)) return false;
    const afterRead = fstatSync(fd);
    if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs) return false;
    const begin = start > 0 ? bytes.indexOf(10) + 1 : 0, end = bytes.lastIndexOf(10);
    if (end < begin || start > 0 && begin === 0) return false;
    let activeTurn; const pending = new Set(), completed = new Set();
    for (const line of bytes.subarray(begin, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), p = record.payload;
      if (!p || typeof p !== 'object') return false;
      if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)
        && (p.turn_id === turnId || p.turn_id == null && activeTurn === turnId)) return false;
      if (record.type === 'event_msg' && p.type === 'task_started' || record.type === 'turn_context') {
        if (activeTurn !== p.turn_id) { pending.clear(); completed.clear(); }
        activeTurn = p.turn_id; continue;
      }
      if (activeTurn !== turnId) continue;
      if (record.type !== 'response_item' || !validId(p.call_id)) continue;
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        pending.delete(p.call_id); completed.add(p.call_id);
      } else if (['function_call', 'custom_tool_call'].includes(p.type) && typeof p.name === 'string'
        && p.name && !completed.has(p.call_id)) pending.add(p.call_id);
    }
    return activeTurn === turnId && pending.size > 0;
  } catch { return false; } // Missing, truncated, moved or unsupported history never breaks a reply.
  finally { if (fd !== undefined) closeSync(fd); }
}
