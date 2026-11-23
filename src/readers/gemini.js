// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl (v0.39+) or .json (older).
//
// JSONL is an append-only log that is replayed: message records (the same id is
// re-appended in full on every update; last wins), {$set}, {$patch}, and
// {$rewindTo}. A cancelled turn is *rewound* out of history, so we keep rewound
// messages and treat the rewind as the user cancelling.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLines, tryJSON } from '../lines.js';
import { toolKind, classifyToolError, diffLines, toMs } from '../text.js';

export const id = 'gemini';
export const label = 'Gemini CLI';

export function roots() {
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  return [path.join(home, '.gemini', 'tmp'), path.join(os.homedir(), '.cache', '.gemini', 'tmp')];
}

export async function discover() {
  const units = [];
  for (const root of roots()) {
    let projects = [];
    try {
      projects = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chats = path.join(root, p.name, 'chats');
      let files = [];
      try {
        files = await fs.readdir(chats, { withFileTypes: true });
      } catch {
        continue;
      }
      const names = new Set(files.filter((f) => f.isFile()).map((f) => f.name));
      for (const name of names) {
        if (!/^session-.*\.jsonl?$/.test(name)) continue;
        // A resumed legacy session gets a .jsonl next to the old .json; read only the .jsonl.
        if (name.endsWith('.json') && names.has(`${name}l`)) continue;
        units.push(path.join(chats, name));
      }
    }
  }
  return units;
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content?.text || '';
  return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
}
const hasFunctionResponse = (content) => Array.isArray(content) && content.some((p) => p && p.functionResponse);

const IGNORED_PREFIX = ['/', '?', '<session_context>', '<hook_context>'];

export async function parse(file) {
  let meta = {};
  const entries = []; // { rec, removed }
  const byId = new Map();

  const put = (rec) => {
    const e = byId.get(rec.id);
    if (e && !e.removed) e.rec = rec;
    else {
      const ne = { rec, removed: false };
      entries.push(ne);
      byId.set(rec.id, ne);
    }
  };

  if (file.endsWith('.json')) {
    const obj = tryJSON(await fs.readFile(file, 'utf8'));
    if (!obj) return [];
    meta = obj;
    for (const m of obj.messages || []) if (m?.id) put(m);
  } else {
    for await (const line of readLines(file)) {
      const d = tryJSON(line);
      if (!d || typeof d !== 'object') continue;
      if (d.$rewindTo) {
        const e = byId.get(d.$rewindTo);
        const idx = e ? entries.indexOf(e) : -1;
        if (idx >= 0) for (let i = idx; i < entries.length; i++) markRemoved(entries[i], byId);
      } else if (d.$set) {
        if (Array.isArray(d.$set.messages)) {
          entries.length = 0;
          byId.clear();
          for (const m of d.$set.messages) if (m?.id) put(m);
        }
        meta = { ...meta, ...d.$set, messages: undefined };
      } else if (d.$patch) {
        applyPatch(d.$patch, byId, entries);
      } else if (d.id && d.type) {
        put(d);
      } else if (d.sessionId) {
        meta = { ...meta, ...d };
      }
    }
  }
  if (meta.kind === 'subagent') return [];

  const events = [];
  let lastModel = null;
  for (const { rec, removed } of entries) {
    const t = toMs(rec.timestamp);
    if (rec.type === 'user') {
      if (hasFunctionResponse(rec.content)) continue;
      const text = partsText(rec.displayContent ?? rec.content).trim();
      if (!text || text === 'Please continue.' || IGNORED_PREFIX.some((p) => text.startsWith(p))) continue;
      events.push({ type: 'prompt', t, text, key: `gemini:${meta.sessionId || file}:${rec.id}` });
      if (removed) events.push({ type: 'interrupt', t });
    } else if (rec.type === 'gemini') {
      if (rec.model) lastModel = rec.model;
      const model = rec.model || lastModel;
      if (!model) continue;
      const calls = Array.isArray(rec.toolCalls) ? rec.toolCalls : [];
      events.push({ type: 'assistant', t, model, text: partsText(rec.content), tools: calls.length });
      for (const c of calls) {
        const ev = toolEvent(c, model, toMs(c.timestamp) ?? t);
        if (ev) events.push(ev);
      }
    } else if (rec.type === 'info' && /^Request cancelled/.test(partsText(rec.content))) {
      events.push({ type: 'interrupt', t });
    }
  }
  return [{ agent: id, id: meta.sessionId || path.basename(file), cwd: null, file, events }];
}

function markRemoved(entry, byId) {
  entry.removed = true;
  if (byId.get(entry.rec.id) === entry) byId.delete(entry.rec.id);
}

function applyPatch(p, byId, entries) {
  const updates = [...(p.updates || [])];
  if (p.id) updates.push(p);
  for (const u of updates) {
    const e = byId.get(u.id);
    if (!e) continue;
    const rec = { ...e.rec };
    if (u.content !== undefined) rec.content = u.content;
    if (Array.isArray(u.toolCalls) && Array.isArray(rec.toolCalls)) {
      const byCall = new Map(u.toolCalls.map((c) => [c.id, c]));
      rec.toolCalls = rec.toolCalls.map((c) => (byCall.has(c.id) ? { ...c, ...byCall.get(c.id) } : c));
    }
    e.rec = rec;
  }
  for (const rid of p.removeIds || []) {
    const e = byId.get(rid);
    if (e) markRemoved(e, byId);
  }
  if (Array.isArray(p.orderIds)) {
    const pos = new Map(p.orderIds.map((x, i) => [x, i]));
    const live = entries.filter((e) => !e.removed && pos.has(e.rec.id));
    live.sort((a, b) => pos.get(a.rec.id) - pos.get(b.rec.id));
    let k = 0;
    for (let i = 0; i < entries.length; i++) if (!entries[i].removed && pos.has(entries[i].rec.id)) entries[i] = live[k++];
  }
}

function responseOf(call) {
  const r = Array.isArray(call.result) ? call.result.find((p) => p?.functionResponse) : null;
  return r?.functionResponse?.response || {};
}

function toolEvent(call, model, t) {
  const kind = toolKind(call.name);
  let status;
  if (call.status === 'success') status = 'ok';
  else if (call.status === 'error') status = classifyToolError(responseOf(call).error || call.resultDisplay);
  else if (call.status === 'cancelled') status = 'rejected';
  else return null; // still running / awaiting approval
  if (status === 'ok' && kind === 'shell') {
    const out = String(responseOf(call).output || '');
    const m = out.match(/^Exit Code: (-?\d+)$/im);
    if (m && Number(m[1]) !== 0) status = 'error';
  }
  const ev = { type: 'tool', t, model, name: call.name, kind, status };
  if (kind === 'edit' && status === 'ok') {
    const a = call.args || {};
    const p = a.file_path || a.path;
    if (p && call.name === 'write_file') ev.edits = [{ path: p, mode: 'write', removed: [], added: diffLines('', a.content).added }];
    else if (p) ev.edits = [{ path: p, mode: 'patch', ...diffLines(a.old_string, a.new_string) }];
  }
  return ev;
}

