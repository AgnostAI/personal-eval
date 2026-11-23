// Claude Code: ~/.claude/projects/<project>/<session>.jsonl
// One JSON record per line. Assistant records carry message.model; each
// content block is usually its own record sharing message.id. Tool results come
// back as user records with tool_result blocks (plus a structured toolUseResult).
import os from 'node:os';
import path from 'node:path';
import { readLines, tryJSON } from '../lines.js';
import { walk } from './fs.js';
import {
  humanText, isInterruptText, toolKind, classifyToolError, diffLines, toMs,
} from '../text.js';

export const id = 'claude';
export const label = 'Claude Code';

export function roots() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(base, 'projects')];
}

export async function discover() {
  const units = [];
  for (const root of roots()) {
    for await (const f of walk(root, (p) => p.endsWith('.jsonl'), (d) => path.basename(d) === 'subagents')) {
      units.push(f);
    }
  }
  return units;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '')).join('\n');
}

export async function parse(file) {
  const events = [];
  const pending = new Map(); // tool_use id -> { name, input, model }
  let cwd = null;
  let sessionId = path.basename(file, '.jsonl');
  let lastMsgId = null;

  for await (const line of readLines(file)) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const d = tryJSON(line);
    if (!d || (d.type !== 'user' && d.type !== 'assistant')) continue;
    if (d.isSidechain) continue;
    const m = d.message;
    if (!m || typeof m !== 'object') continue;
    const t = toMs(d.timestamp);
    cwd ||= d.cwd || null;
    if (d.sessionId) sessionId = d.sessionId;

    if (d.type === 'assistant') {
      const model = m.model;
      if (!model || model === '<synthetic>') continue;
      const content = Array.isArray(m.content) ? m.content : [];
      let text = '';
      let tools = 0;
      for (const b of content) {
        if (b?.type === 'text') text += b.text || '';
        else if (b?.type === 'tool_use') {
          tools++;
          pending.set(b.id, { name: b.name, input: b.input || {}, model });
        }
      }
      // Streaming writes one record per block; merge records of the same message.
      const msgId = m.id || d.uuid;
      if (msgId && msgId === lastMsgId && events.length && events[events.length - 1].type === 'assistant') {
        const prev = events[events.length - 1];
        prev.text += text;
        prev.tools += tools;
        prev.t = t ?? prev.t;
      } else {
        events.push({ type: 'assistant', t, model, text, tools });
      }
      lastMsgId = msgId;
      continue;
    }

    // user record
    lastMsgId = null;
    const content = m.content;
    const results = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
    if (results.length) {
      for (const r of results) {
        const call = pending.get(r.tool_use_id);
        if (!call) continue;
        pending.delete(r.tool_use_id);
        const kind = toolKind(call.name);
        const status = r.is_error ? classifyToolError(blockText(r.content)) : 'ok';
        const ev = { type: 'tool', t, model: call.model, name: call.name, kind, status };
        if (kind === 'edit' && status === 'ok') {
          ev.edits = editsFor(call, results.length === 1 ? d.toolUseResult : null);
        }
        events.push(ev);
      }
      continue;
    }
    if (d.isMeta) continue;
    if (d.turnOrigin === 'task_notification' || d.turnOrigin === 'scheduled') continue;
    const raw = blockText(content);
    if (isInterruptText(raw)) {
      events.push({ type: 'interrupt', t });
      continue;
    }
    const text = humanText(raw);
    if (text == null) continue;
    events.push({ type: 'prompt', t, text, key: d.uuid ? `claude:${d.uuid}` : null });
  }

  return [{ agent: id, id: sessionId, cwd, file, events }];
}

function editsFor(call, result) {
  const input = call.input || {};
  const name = String(call.name).toLowerCase();
  const filePath = input.file_path || input.path || input.notebook_path || result?.filePath;
  if (!filePath) return [];
  if (name === 'edit' || name === 'str_replace_based_edit_tool' || name === 'str_replace_editor') {
    if (input.command && input.command !== 'str_replace' && input.command !== 'create' && input.command !== 'insert') return [];
    if (input.command === 'create') return [{ path: filePath, mode: 'write', removed: [], added: diffLines('', input.file_text).added }];
    if (input.command === 'insert') return [{ path: filePath, mode: 'patch', removed: [], added: diffLines('', input.new_str).added }];
    return [{ path: filePath, mode: 'patch', ...diffLines(input.old_string ?? input.old_str, input.new_string ?? input.new_str) }];
  }
  if (name === 'multiedit') {
    return (input.edits || []).map((e) => ({ path: filePath, mode: 'patch', ...diffLines(e.old_string, e.new_string) }));
  }
  if (name === 'write') {
    if (result && typeof result.originalFile === 'string') {
      return [{ path: filePath, mode: 'patch', ...diffLines(result.originalFile, input.content) }];
    }
    // Unknown prior content: a full overwrite replaces everything we tracked.
    return [{ path: filePath, mode: 'write', removed: [], added: diffLines('', input.content).added }];
  }
  return [];
}
