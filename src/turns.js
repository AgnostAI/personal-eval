// Group a session's normalized events into turns and attribute everything
// (tool outcomes, line churn, the user's next message) to the model that ran it.
//
// Normalized events produced by every reader:
//   { type: 'prompt', t, text, key }             a real human message
//   { type: 'interrupt', t }                     the user stopped the agent
//   { type: 'assistant', t, model, text, tools } one assistant message
//   { type: 'tool', t, model, name, kind: 'shell'|'edit'|'other',
//     status: 'ok'|'error'|'rejected'|'malformed', edits?: [{path, mode, removed, added}] }

const MAX_TEXT = 600;
const BULK_LINES = 500;

export function buildTurns(session) {
  const turns = [];
  let cur = null;
  let lastModel = null;
  const tracked = new Map(); // path -> Map(line -> [turnIndex, …])

  const close = () => {
    if (!cur) return;
    // A prompt the agent never answered (the user sent two messages back to back) isn't a turn.
    if (!cur.assistantMsgs && !cur.tools.calls && !cur.cancelled) {
      cur = null;
      return;
    }
    let best = null;
    let bestN = 0;
    for (const [m, n] of cur.modelCounts) if (n > bestN) [best, bestN] = [m, n];
    cur.model = best || lastModel;
    delete cur.modelCounts;
    turns.push(cur);
  };

  for (const ev of session.events) {
    if (ev.type === 'prompt') {
      if (cur) cur.followUp = ev.text.slice(0, MAX_TEXT);
      close();
      cur = {
        key: ev.key,
        agent: session.agent,
        session: session.id,
        cwd: session.cwd,
        start: ev.t,
        end: ev.t,
        prompt: ev.text.slice(0, 200),
        followUp: null,
        finalText: null,
        endedOnTool: false,
        cancelled: false,
        modelCounts: new Map(),
        assistantMsgs: 0,
        tools: { calls: 0, shell: 0, shellErr: 0, edit: 0, editErr: 0, malformed: 0, rejected: 0 },
        lines: { added: 0, sameTurn: 0, later: 0 },
      };
      continue;
    }
    if (!cur) continue; // activity before the first human prompt (e.g. a resumed tail)

    if (ev.type === 'interrupt') {
      cur.cancelled = true;
      continue;
    }
    if (ev.model) {
      cur.modelCounts.set(ev.model, (cur.modelCounts.get(ev.model) || 0) + 1);
      lastModel = ev.model;
    }
    if (ev.t != null && (cur.end == null || ev.t > cur.end)) cur.end = ev.t;

    if (ev.type === 'assistant') {
      cur.assistantMsgs++;
      // The reply the user saw last: text of the final assistant message ('' if empty/tool-only).
      cur.finalText = (ev.text || '').trim().slice(-MAX_TEXT);
      cur.endedOnTool = ev.tools > 0;
      continue;
    }
    if (ev.type === 'tool') {
      cur.endedOnTool = true;
      const tl = cur.tools;
      if (ev.status === 'malformed') {
        tl.malformed++;
        tl.calls++;
        continue;
      }
      if (ev.status === 'rejected') {
        tl.rejected++;
        continue;
      }
      tl.calls++;
      if (ev.kind === 'shell') {
        tl.shell++;
        if (ev.status === 'error') tl.shellErr++;
      } else if (ev.kind === 'edit') {
        tl.edit++;
        if (ev.status === 'error') tl.editErr++;
      }
      if (ev.edits) for (const e of ev.edits) trackEdit(tracked, e, turns, turns.length, cur);
    }
  }
  close();

  const prompts = turns.length;
  for (const t of turns) t.interactive = prompts >= 2;
  return turns.filter((t) => t.model);
}

function trackEdit(tracked, edit, turns, curIndex, cur) {
  if (!edit?.path) return;
  let file = tracked.get(edit.path);
  if (!file) tracked.set(edit.path, (file = new Map()));

  let removed = edit.removed || [];
  let added = edit.added || [];
  if (edit.mode === 'delete') {
    removed = [];
    for (const [line, owners] of file) for (let i = 0; i < owners.length; i++) removed.push(line);
    added = [];
  } else if (edit.mode === 'write') {
    // Whole-file write with unknown prior content: diff against what we tracked.
    const next = new Map();
    for (const l of added) next.set(l, (next.get(l) || 0) + 1);
    const rm = [];
    for (const [line, owners] of file) {
      const keep = next.get(line) || 0;
      for (let i = keep; i < owners.length; i++) rm.push(line);
    }
    const ad = [];
    const have = new Map();
    for (const [line, owners] of file) have.set(line, owners.length);
    for (const l of added) {
      const h = have.get(l) || 0;
      if (h > 0) have.set(l, h - 1);
      else ad.push(l);
    }
    removed = rm;
    added = ad;
  }

  for (const line of removed) {
    const owners = file.get(line);
    if (!owners || !owners.length) continue;
    const owner = owners.pop();
    if (!owners.length) file.delete(line);
    const target = owner === curIndex ? cur : turns[owner];
    if (!target) continue;
    if (owner === curIndex) target.lines.sameTurn++;
    else target.lines.later++;
  }
  // Bulk writes (generated code, fixtures, data files) would swamp the ratio; don't track them.
  if (added.length > BULK_LINES) return;
  for (const line of added) {
    let owners = file.get(line);
    if (!owners) file.set(line, (owners = []));
    owners.push(curIndex);
    cur.lines.added++;
  }
}
