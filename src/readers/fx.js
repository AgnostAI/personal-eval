// fx (fx.sh): ~/.fx/sessions/v2/<id>/log.jsonl (v0.0.15+), or the older
// ~/.fx/sessions/<id>/events.jsonl + session.json (v0.0.8–0.0.14).
//
// v2 lines: {"v":1,"seq","ts","kind", …,"crc"}. Conversation pieces are
// kind:"item" with {type, data}; data over 256 KiB is {"$blob": sha} stored in
// <id>/blobs/<sha>. Older logs carry the same payloads as {"event":{<type>:{…}}}.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLines, tryJSON } from '../lines.js';
import { toolKind, classifyToolError, diffLines, toMs } from '../text.js';

export const id = 'fx';
export const label = 'fx';

export function roots() {
  const base = process.env.FX_HOME || path.join(os.homedir(), '.fx');
  return [path.join(base, 'sessions')];
}

export async function discover() {
  const units = [];
  for (const root of roots()) {
    const v2 = path.join(root, 'v2');
    for (const dir of await subdirs(v2)) units.push(path.join(v2, dir, 'log.jsonl'));
    for (const dir of await subdirs(root)) {
      if (dir === 'v2') continue;
      units.push(path.join(root, dir, 'events.jsonl'));
    }
  }
  const out = [];
  for (const u of units) {
    try {
      await fs.access(u);
      out.push(u);
    } catch {}
  }
  return out;
}

async function subdirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadBlob(dir, data) {
  if (!data || typeof data !== 'object' || !data.$blob) return data;
  try {
    return tryJSON(await fs.readFile(path.join(dir, 'blobs', data.$blob), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

const shortModel = (m) => (typeof m === 'string' ? m : m?.model || m?.id || null);

export async function parse(file) {
  const dir = path.dirname(file);
  const legacy = path.basename(file) === 'events.jsonl';
  let curModel = null;
  let sessionId = path.basename(dir);
  let cwd = null;
  if (legacy) {
    const meta = tryJSON(await fs.readFile(path.join(dir, 'session.json'), 'utf8').catch(() => 'null'));
    if (meta?.subagent_child) return [];
    curModel = shortModel(meta?.model);
    cwd = meta?.workspace || meta?.cwd || null;
  }

  const events = [];
  const pending = new Map(); // call_id -> { name, args, model }
  let lastPrompt = null; // index of the last user prompt event, until we know who wrote it

  for await (const line of readLines(file)) {
    const d = tryJSON(line);
    if (!d) continue; // torn tail after a crash is normal
    const t = toMs(d.ts ?? d.timestamp_ms);
    let type;
    let data;
    if (legacy) {
      if (!d.event || typeof d.event !== 'object') continue;
      [type] = Object.keys(d.event);
      data = d.event[type];
      if (type === 'interrupted') type = 'interruption';
    } else {
      if (d.kind === 'session_created') {
        if (d.role === 'child') return [];
        sessionId = d.id || sessionId;
        cwd = d.workspace || null;
        continue;
      }
      if (d.kind === 'set' && d.key === 'prefs') {
        curModel = shortModel(d.value?.model) || curModel;
        continue;
      }
      if (d.kind === 'turn_interrupted') {
        if (d.reason === 'cancel') events.push({ type: 'interrupt', t });
        continue;
      }
      if (d.kind !== 'item') continue;
      type = d.type;
      data = await loadBlob(dir, d.data);
    }
    if (!data || typeof data !== 'object') continue;

    switch (type) {
      case 'user': {
        if (data.work_id) break; // written by a parent agent
        const text = String(data.text || '').trim();
        if (!text) break;
        lastPrompt = events.length;
        events.push({ type: 'prompt', t, text, key: `fx:${sessionId}:${d.seq ?? events.length}` });
        break;
      }
      case 'author':
        // A user item followed by author {by: child|parent} wasn't typed by the human.
        if ((data.by === 'child' || data.by === 'parent') && lastPrompt != null && events[lastPrompt]?.type === 'prompt') {
          events.splice(lastPrompt, 1);
        }
        lastPrompt = null;
        break;
      case 'model_call':
        if (data.model) curModel = data.model;
        break;
      case 'assistant': {
        lastPrompt = null;
        const model = data.provider_replay?.source?.model || curModel;
        if (!model) break;
        events.push({ type: 'assistant', t, model, text: String(data.text || ''), tools: 0 });
        break;
      }
      case 'tool_call': {
        lastPrompt = null;
        const model = curModel;
        if (data.argument_integrity === 'malformed_json' || data.argument_integrity === 'non_object_json') {
          events.push({ type: 'tool', t, model, name: data.tool_name, kind: 'other', status: 'malformed' });
          break;
        }
        pending.set(data.call_id, { name: data.tool_name, args: tryJSON(data.arguments_json) || {}, model });
        const last = events[events.length - 1];
        if (last?.type === 'assistant') last.tools++;
        break;
      }
      case 'tool_result': {
        const call = pending.get(data.call_id) || { name: data.tool_name, args: {}, model: curModel };
        pending.delete(data.call_id);
        const kind = toolKind(call.name);
        let status = data.status === 'failure' ? classifyToolError(data.preview) : 'ok';
        const proc = data.command_process_presentation;
        if (kind === 'shell' && proc && typeof proc === 'object' && typeof proc.exit_code === 'number' && proc.exit_code !== 0) status = 'error';
        const ev = { type: 'tool', t, model: call.model, name: call.name, kind, status };
        if (kind === 'edit' && status === 'ok') {
          const a = call.args;
          if (call.name === 'write_file' && a.path) ev.edits = [{ path: a.path, mode: 'write', removed: [], added: diffLines('', a.content).added }];
          else if (a.path) ev.edits = [{ path: a.path, mode: 'patch', ...diffLines(a.old_string, a.new_string) }];
        }
        events.push(ev);
        break;
      }
      case 'interruption':
        if (legacy && (data.reason === 'cancelled' || data.reason === 'cancel')) events.push({ type: 'interrupt', t });
        break;
      default:
        break;
    }
  }
  return [{ agent: id, id: sessionId, cwd, file, events }];
}
