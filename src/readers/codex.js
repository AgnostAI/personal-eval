// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (newer builds: .jsonl.zst)
// Records are {timestamp, type, payload}. The model comes from turn_context.
//
// Two dialects exist:
//  - newer: event_msg/item_completed with typed items (UserMessage, AgentMessage,
//    CommandExecution{exit_code}, FileChange{changes}, McpToolCall)
//  - older: event_msg user_message/agent_message + response_item function_call /
//    function_call_output (+ exec_command_end / patch_apply_end events)
import os from 'node:os';
import path from 'node:path';
import { readLines, tryJSON } from '../lines.js';
import { walk } from './fs.js';
import {
  humanText, toolKind, isMalformedText, isRejectedText, applyPatchEdits, unifiedDiffLines, diffLines, toMs,
} from '../text.js';

export const id = 'codex';
export const label = 'Codex';

export function roots() {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [path.join(base, 'sessions'), path.join(base, 'archived_sessions')];
}

export async function discover() {
  const units = [];
  for (const root of roots()) {
    for await (const f of walk(root, (p) => /rollout-.*\.jsonl(\.zst)?$/.test(p))) units.push(f);
  }
  return units;
}

const INTERESTING = [
  '"session_meta"', '"turn_context"', '"item_completed"', '"turn_aborted"', '"user_message"',
  '"agent_message"', '"function_call"', '"custom_tool_call"', '"local_shell_call"', '_call_output"',
  '"exec_command_end"', '"patch_apply_end"',
];

const SKIP_RECORDS = new Set(['compacted', 'token_usage_record', 'world_state', 'inter_agent_communication_metadata']);
const SKIP_RESPONSE = new Set(['reasoning', 'message', 'additional_tools', 'agent_message', 'configuration_update', 'web_search_call', 'image_generation_call']);
const KEEP_EVENTS = new Set(['item_completed', 'turn_aborted', 'user_message', 'agent_message', 'exec_command_end', 'patch_apply_end']);
const KEEP_ITEMS = new Set(['UserMessage', 'AgentMessage', 'CommandExecution', 'FileChange', 'McpToolCall']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
}

export async function parse(file) {
  const modern = [];
  const legacy = [];
  let isModern = false;
  let sessionId = null;
  let cwd = null;
  let skipBefore = -1;
  let curModel = null;
  const turnModel = new Map();
  const pending = new Map(); // legacy call_id -> { name, kind, model, input, ev }
  const modelFor = (turnId) => (turnId && turnModel.get(turnId)) || curModel;

  const skip = (head) => {
    const m = head.match(/"type":"(\w+)","payload":\{(?:"type":"(\w+)")?/);
    if (!m) return false;
    const [, rec, ptype] = m;
    if (SKIP_RECORDS.has(rec)) return true;
    if (rec === 'response_item') {
      if (SKIP_RESPONSE.has(ptype)) return true;
      if (isModern && (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'local_shell_call')) return true;
      return false;
    }
    if (rec === 'event_msg') {
      if (ptype === 'item_completed') {
        const it = head.match(/"item":\{"type":"(\w+)"/);
        return !!it && !KEEP_ITEMS.has(it[1]);
      }
      return !KEEP_EVENTS.has(ptype);
    }
    return false;
  };

  for await (const line of readLines(file, { skip })) {
    if (!INTERESTING.some((s) => line.includes(s))) continue;
    // Cheap skip: in the modern dialect, raw call outputs only matter if they look malformed.
    if (isModern && line.includes('_call_output"') && !/Script failed|failed to parse|unsupported call|Invalid params|missing field|InputValidation|apply_patch verification failed/i.test(line)) continue;
    if (isModern && (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"'))) continue;
    const d = tryJSON(line);
    if (!d) continue;
    if (typeof d.ordinal === 'number' && d.ordinal < skipBefore) continue;
    const p = d.payload || {};
    const t = toMs(d.timestamp);

    if (d.type === 'session_meta') {
      if (p.source && typeof p.source === 'object' && p.source.subagent) return [];
      if (typeof p.subagent_history_start_ordinal === 'number') skipBefore = p.subagent_history_start_ordinal;
      sessionId ||= p.id || p.session_id;
      cwd ||= p.cwd || null;
      continue;
    }
    if (d.type === 'turn_context') {
      if (p.model) {
        curModel = p.model;
        if (p.turn_id) turnModel.set(p.turn_id, p.model);
      }
      cwd ||= p.cwd || null;
      continue;
    }

    if (d.type === 'event_msg') {
      if (p.type === 'item_completed' && p.item) {
        isModern = true;
        const ev = modernEvent(p.item, modelFor(p.turn_id), toMs(p.completed_at_ms) ?? t);
        if (ev) modern.push(ev);
        continue;
      }
      if (p.type === 'turn_aborted') {
        if (!p.reason || p.reason === 'interrupted') {
          modern.push({ type: 'interrupt', t });
          legacy.push({ type: 'interrupt', t });
        }
        continue;
      }
      if (isModern) continue;
      if (p.type === 'user_message') {
        const text = humanText(textOf(p.message));
        if (text != null) legacy.push({ type: 'prompt', t, text, key: null });
      } else if (p.type === 'agent_message') {
        legacy.push({ type: 'assistant', t, model: curModel, text: textOf(p.message), tools: 0 });
      } else if (p.type === 'exec_command_end') {
        const c = pending.get(p.call_id);
        if (c?.ev) c.ev.status = p.exit_code === 0 ? 'ok' : 'error';
      } else if (p.type === 'patch_apply_end') {
        const c = pending.get(p.call_id);
        if (c?.ev) {
          c.ev.status = p.success ? 'ok' : 'error';
          if (!p.success) delete c.ev.edits;
        }
      }
      continue;
    }

    if (d.type !== 'response_item') continue;
    if (isModern) {
      // Only malformed-call detection is taken from raw outputs in the modern dialect.
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = textOf(p.output);
        const turnId = p.internal_chat_message_metadata_passthrough?.turn_id;
        // Failed patches never become FileChange items; they only show up in the call output.
        const failedPatches = out.match(/apply_patch verification failed/g)?.length || 0;
        for (let i = 0; i < failedPatches; i++) {
          modern.push({ type: 'tool', t, model: modelFor(turnId), name: 'apply_patch', kind: 'edit', status: 'error' });
        }
        if (isMalformedText(out) || (/^Script failed/.test(out) && /SyntaxError/.test(out.slice(0, 600)))) {
          modern.push({ type: 'tool', t, model: modelFor(turnId), name: 'call', kind: 'other', status: 'malformed' });
        }
      }
      continue;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const name = p.type === 'local_shell_call' ? 'local_shell' : p.name;
      let input = p.type === 'custom_tool_call' ? p.input : p.arguments;
      if (typeof input === 'string' && p.type === 'function_call') input = tryJSON(input) ?? input;
      if (p.type === 'local_shell_call') input = p.action;
      const kind = toolKind(name);
      const ev = { type: 'tool', t, model: curModel, name, kind, status: 'ok' };
      if (kind === 'edit') {
        const patch = typeof input === 'string' ? input : input?.input || input?.patch || '';
        ev.edits = applyPatchEdits(patch);
      }
      legacy.push({ type: 'assistant', t, model: curModel, text: '', tools: 1, toolOnly: true });
      legacy.push(ev);
      pending.set(p.call_id || p.id, { ev });
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const c = pending.get(p.call_id);
      if (!c) continue;
      const out = typeof p.output === 'string' ? p.output : textOf(p.output?.content ?? p.output);
      c.ev.status = legacyStatus(c.ev.kind, out);
      if (c.ev.status !== 'ok') delete c.ev.edits;
    }
  }

  const events = isModern ? modern : legacy;
  return [{ agent: id, id: sessionId || path.basename(file), cwd, file, events }];
}

function modernEvent(item, model, t) {
  switch (item.type) {
    case 'UserMessage': {
      const text = humanText(textOf(item.content));
      return text == null ? null : { type: 'prompt', t, text, key: item.id ? `codex:${item.id}` : null };
    }
    case 'AgentMessage':
      return { type: 'assistant', t, model, text: textOf(item.content), tools: 0 };
    case 'CommandExecution': {
      let status = 'ok';
      if (item.status === 'declined') status = 'rejected';
      else if (item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)) status = 'error';
      return { type: 'tool', t, model, name: 'exec_command', kind: 'shell', status };
    }
    case 'FileChange': {
      let status = 'ok';
      if (item.status === 'declined') status = 'rejected';
      else if (item.status && item.status !== 'completed') status = 'error';
      const ev = { type: 'tool', t, model, name: 'apply_patch', kind: 'edit', status };
      if (status === 'ok') {
        ev.edits = Object.entries(item.changes || {}).map(([p, ch]) => {
          if (ch?.type === 'add') return { path: p, mode: 'write', removed: [], added: diffLines('', ch.content).added };
          if (ch?.type === 'delete') return { path: p, mode: 'delete', removed: [], added: [] };
          return { path: ch?.move_path || p, mode: 'patch', ...unifiedDiffLines(ch?.unified_diff) };
        });
      }
      return ev;
    }
    case 'McpToolCall': {
      const failed = item.status === 'failed' || item.status === 'error';
      const errText = failed ? JSON.stringify(item.error ?? item.result ?? '').slice(0, 2000) : '';
      const status = !failed ? 'ok' : isMalformedText(errText) ? 'malformed' : isRejectedText(errText) ? 'rejected' : 'error';
      return { type: 'tool', t, model, name: `${item.server}.${item.tool}`, kind: 'other', status };
    }
    default:
      return null;
  }
}

function legacyStatus(kind, out) {
  const text = String(out || '');
  if (isMalformedText(text)) return 'malformed';
  if (isRejectedText(text)) return 'rejected';
  if (kind === 'shell') {
    const j = tryJSON(text);
    const code = j?.metadata?.exit_code ?? j?.exit_code ?? matchExit(text);
    return code == null || code === 0 ? 'ok' : 'error';
  }
  if (kind === 'edit') {
    if (/^Success|^Done!|Updated the following files/m.test(text)) return 'ok';
    if (/verification failed|failed to apply|error|invalid hunk|could not find/i.test(text.slice(0, 500))) return 'error';
  }
  return 'ok';
}

function matchExit(text) {
  const m = text.match(/(?:exit(?:ed with)?[ _]code|Process exited with code)["\s:]*(-?\d+)/i);
  return m ? Number(m[1]) : null;
}
