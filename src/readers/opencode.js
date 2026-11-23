// opencode: data dir $XDG_DATA_HOME/opencode or ~/.local/share/opencode.
// Three storage generations, all handled:
//   A  JSON files   storage/{session,message,part}/…           (≤ v1.1)
//   B  sqlite v1    opencode*.db: session / message / part       (v1.2 – v1.19)
//   C  sqlite v2    opencode*.db: session_v2 / session_message / session_part (v2.x)
// v2 copies v1 rows forward and v1.2 copied the JSON files, so the same session
// can appear more than once; turns are de-duplicated by message id downstream.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tryJSON } from '../lines.js';
import { toolKind, classifyToolError, applyPatchEdits, diffLines } from '../text.js';

export const id = 'opencode';
export const label = 'opencode';

export function dataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
}
export function roots() {
  return [dataDir()];
}

export async function discover() {
  const dir = dataDir();
  const units = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return units;
  }
  const custom = process.env.OPENCODE_DB && path.resolve(dir, process.env.OPENCODE_DB);
  for (const e of entries) if (/^opencode.*\.db$/.test(e)) units.push(path.join(dir, e));
  if (custom && !units.includes(custom)) units.push(custom);
  // Generation A: one unit per session's message directory.
  const msgRoot = path.join(dir, 'storage', 'message');
  try {
    for (const s of await fs.readdir(msgRoot)) units.push(path.join(msgRoot, s));
  } catch {}
  return units;
}

export async function parse(unit) {
  if (unit.endsWith('.db')) return parseDb(unit);
  return parseJsonSession(unit);
}

// ---------- sqlite ----------

async function openDb(file) {
  let sqlite;
  try {
    process.removeAllListeners('warning'); // node:sqlite prints an ExperimentalWarning on some versions
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('reading opencode needs Node 22.5+ (node:sqlite)');
  }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

async function parseDb(file) {
  const db = await openDb(file);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const out = [];
    if (tables.has('session_v2') && tables.has('session_message')) out.push(...parseV2(db, tables));
    if (tables.has('session') && tables.has('message') && tables.has('part')) out.push(...parseV1(db));
    return out.map((s) => ({ ...s, file }));
  } finally {
    db.close();
  }
}

function parseV1(db) {
  const sessions = db.prepare('SELECT id, directory FROM session WHERE parent_id IS NULL').all();
  const msgStmt = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id');
  const partStmt = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id');
  const out = [];
  for (const s of sessions) {
    const parts = new Map();
    for (const p of partStmt.all(s.id)) {
      if (!parts.has(p.message_id)) parts.set(p.message_id, []);
      parts.get(p.message_id).push(tryJSON(p.data) || {});
    }
    const messages = msgStmt.all(s.id).map((m) => ({ id: m.id, ...(tryJSON(m.data) || {}), _t: m.time_created }));
    out.push({ agent: id, id: s.id, cwd: s.directory, events: v1Events(messages, parts) });
  }
  return out;
}

function parseV2(db, tables) {
  const sessions = db.prepare('SELECT id, directory FROM session_v2 WHERE parent_id IS NULL').all();
  const msgStmt = db.prepare('SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq');
  const partStmt = tables.has('session_part')
    ? db.prepare('SELECT message_id, type, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal')
    : null;
  const out = [];
  for (const s of sessions) {
    const parts = new Map();
    if (partStmt) {
      for (const p of partStmt.all(s.id)) {
        if (!parts.has(p.message_id)) parts.set(p.message_id, []);
        parts.get(p.message_id).push({ type: p.type, ...(tryJSON(p.data) || {}) });
      }
    }
    const events = [];
    for (const m of msgStmt.all(s.id)) {
      const data = tryJSON(m.data) || {};
      const t = data.time?.created ?? m.time_created;
      if (m.type === 'user') {
        const text = String(data.text || '').trim();
        if (text) events.push({ type: 'prompt', t, text, key: `opencode:${m.id}` });
      } else if (m.type === 'idle') {
        if (data.outcome === 'interrupted') events.push({ type: 'interrupt', t });
      } else if (m.type === 'assistant') {
        const model = data.model?.id || null;
        if (!model) continue;
        const content = [...(parts.get(m.id) || []), ...(Array.isArray(data.content) ? data.content : [])];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
        const tools = content.filter((c) => c.type === 'tool');
        const tEnd = data.time?.completed ?? t;
        events.push({ type: 'assistant', t: tEnd, model, text, tools: tools.length });
        for (const c of tools) {
          const ev = v2Tool(c, model, tEnd);
          if (ev) events.push(ev);
        }
        if (data.error?.type === 'aborted') events.push({ type: 'interrupt', t: tEnd });
      }
    }
    out.push({ agent: id, id: s.id, cwd: s.directory, events });
  }
  return out;
}

function v2Tool(c, model, t) {
  const st = c.state || {};
  const kind = toolKind(c.name);
  let status;
  if (st.status === 'completed') status = 'ok';
  else if (st.status === 'error') {
    const type = st.error?.type || '';
    const msg = st.error?.message || '';
    if (type === 'tool.input-json' || type === 'tool.input-incomplete') status = 'malformed';
    else if (type === 'aborted') {
      if (/declined/i.test(msg)) status = 'rejected';
      else return null; // interrupted mid-run; the turn is marked cancelled instead
    } else status = classifyToolError(msg) === 'malformed' ? 'malformed' : 'error';
  } else return null;
  if (status === 'ok' && kind === 'shell' && typeof st.metadata?.exit === 'number' && st.metadata.exit !== 0) status = 'error';
  const ev = { type: 'tool', t, model, name: c.name, kind, status };
  if (status === 'ok' && kind === 'edit') ev.edits = editsFor(c.name, st.input);
  return ev;
}

// ---------- generation A + v1 share message/part shapes ----------

function v1Events(messages, parts) {
  const events = [];
  for (const m of messages) {
    const ps = parts.get(m.id) || [];
    const t = m.time?.created ?? m._t;
    if (m.role === 'user') {
      const text = ps.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => p.text || '').join('\n').trim();
      if (text) events.push({ type: 'prompt', t, text, key: `opencode:${m.id}` });
    } else if (m.role === 'assistant') {
      const model = m.modelID || null;
      if (!model) continue;
      const tEnd = m.time?.completed ?? t;
      const text = ps.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text || '').join('');
      const tools = ps.filter((p) => p.type === 'tool');
      events.push({ type: 'assistant', t: tEnd, model, text, tools: tools.length });
      for (const p of tools) {
        const ev = v1Tool(p, model, tEnd);
        if (ev) events.push(ev);
      }
      if (m.error?.name === 'MessageAbortedError') events.push({ type: 'interrupt', t: tEnd });
    }
  }
  return events;
}

function v1Tool(p, model, t) {
  const st = p.state || {};
  if (p.tool === 'invalid') return { type: 'tool', t, model, name: 'invalid', kind: 'other', status: 'malformed' };
  const kind = toolKind(p.tool);
  let status;
  if (st.status === 'completed') status = 'ok';
  else if (st.status === 'error') {
    if (/Tool execution aborted/i.test(st.error || '') || st.metadata?.interrupted) return null;
    status = classifyToolError(st.error);
  } else return null;
  if (status === 'ok' && kind === 'shell' && typeof st.metadata?.exit === 'number' && st.metadata.exit !== 0) status = 'error';
  const ev = { type: 'tool', t, model, name: p.tool, kind, status };
  if (status === 'ok' && kind === 'edit') ev.edits = editsFor(p.tool, st.input);
  return ev;
}

function editsFor(name, input = {}) {
  const n = String(name).toLowerCase();
  const file = input.filePath || input.path;
  if (n === 'apply_patch' || n === 'patch') return applyPatchEdits(input.patchText || input.patch || '');
  if (n === 'write' && file) return [{ path: file, mode: 'write', removed: [], added: diffLines('', input.content).added }];
  if (n === 'multiedit') return (input.edits || []).map((e) => ({ path: e.filePath || file, mode: 'patch', ...diffLines(e.oldString, e.newString) }));
  if (n === 'edit' && file) return [{ path: file, mode: 'patch', ...diffLines(input.oldString, input.newString) }];
  return [];
}

async function parseJsonSession(msgDir) {
  const sessionId = path.basename(msgDir);
  const storage = path.dirname(path.dirname(msgDir));
  // Skip sub-agent sessions: their info file has a parentID.
  const info = await findSessionInfo(storage, sessionId);
  if (info?.parentID) return [];
  const messages = [];
  for (const f of await fs.readdir(msgDir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const m = tryJSON(await fs.readFile(path.join(msgDir, f), 'utf8'));
    if (m?.id) messages.push(m);
  }
  messages.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0) || String(a.id).localeCompare(String(b.id)));
  const parts = new Map();
  for (const m of messages) {
    const dir = path.join(storage, 'part', m.id);
    const list = [];
    for (const f of (await fs.readdir(dir).catch(() => [])).sort()) {
      const p = tryJSON(await fs.readFile(path.join(dir, f), 'utf8'));
      if (p) list.push(p);
    }
    parts.set(m.id, list);
  }
  return [{ agent: id, id: sessionId, cwd: info?.directory || null, file: msgDir, events: v1Events(messages, parts) }];
}

async function findSessionInfo(storage, sessionId) {
  const root = path.join(storage, 'session');
  for (const project of await fs.readdir(root).catch(() => [])) {
    const f = path.join(root, project, `${sessionId}.json`);
    const info = tryJSON(await fs.readFile(f, 'utf8').catch(() => 'null'));
    if (info) return info;
  }
  return null;
}
