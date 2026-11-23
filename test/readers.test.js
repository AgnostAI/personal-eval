import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir, writeJsonl, writeJson, iso, ms } from './helpers.js';
import * as claude from '../src/readers/claude.js';
import * as codex from '../src/readers/codex.js';
import * as gemini from '../src/readers/gemini.js';
import * as fx from '../src/readers/fx.js';
import * as opencode from '../src/readers/opencode.js';
import { buildTurns } from '../src/turns.js';
import { parseUnit } from '../src/pipeline.js';

const kinds = (events) => events.map((e) => e.type + (e.status ? `:${e.kind}:${e.status}` : ''));

test('claude: prompts, merged streaming records, tool outcomes, interrupts, churn', async () => {
  const dir = tmpdir('claude');
  const M = 'claude-opus-5-5';
  const file = writeJsonl(path.join(dir, 'proj', 's1.jsonl'), [
    { type: 'user', uuid: 'u1', sessionId: 's1', cwd: '/repo', timestamp: iso(0), message: { role: 'user', content: 'add a greet function' } },
    { type: 'assistant', timestamp: iso(2), message: { id: 'm1', model: M, content: [{ type: 'text', text: 'Adding it.' }] } },
    { type: 'assistant', timestamp: iso(3), message: { id: 'm1', model: M, content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/a.js', content: 'function greet() {\n  return "hi";\n}\n' } }] } },
    { type: 'user', timestamp: iso(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { type: 'create', filePath: '/repo/a.js', content: '...' } },
    { type: 'assistant', timestamp: iso(5), message: { id: 'm2', model: M, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node a.js' } }] } },
    { type: 'user', timestamp: iso(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 1\nboom' }] } },
    { type: 'assistant', timestamp: iso(7), message: { id: 'm3', model: M, content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/a.js', old_string: 'x', new_string: 'y' } }] } },
    { type: 'user', timestamp: iso(8), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: '<tool_use_error>InputValidationError: bad</tool_use_error>' }] } },
    { type: 'assistant', timestamp: iso(9), message: { id: 'm4', model: M, content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'assistant', isSidechain: true, timestamp: iso(9), message: { id: 'sx', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'side' }] } },
    { type: 'user', uuid: 'u2', timestamp: iso(20), message: { role: 'user', content: "that's not what I asked, rename it to hello" } },
    { type: 'assistant', timestamp: iso(22), message: { id: 'm5', model: M, content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: '/repo/a.js', old_string: 'function greet() {', new_string: 'function hello() {' } }] } },
    { type: 'user', timestamp: iso(23), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }] } },
    { type: 'user', timestamp: iso(24), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { type: 'user', uuid: 'u3', isMeta: true, timestamp: iso(25), message: { role: 'user', content: 'Caveat: meta' } },
    { type: 'user', uuid: 'u4', timestamp: iso(30), message: { role: 'user', content: 'ok thanks' } },
  ]);
  const [s] = await claude.parse(file);
  assert.deepEqual(kinds(s.events), [
    'prompt', 'assistant', 'tool:edit:ok', 'assistant', 'tool:shell:error', 'assistant', 'tool:edit:malformed', 'assistant',
    'prompt', 'assistant', 'tool:edit:ok', 'interrupt', 'prompt',
  ]);
  assert.equal(s.events[1].text, 'Adding it.'); // merged with the tool_use record of the same message
  assert.equal(s.events[1].tools, 1);

  const turns = buildTurns(s);
  assert.equal(turns.length, 2); // the last prompt got no reply, so it's only a follow-up
  const [t1, t2] = turns;
  assert.equal(t1.model, M);
  assert.equal(t1.followUp, "that's not what I asked, rename it to hello");
  assert.deepEqual(t1.tools, { calls: 3, shell: 1, shellErr: 1, edit: 1, editErr: 0, malformed: 1, rejected: 0 });
  assert.equal(t1.lines.added, 2); // "function greet() {", 'return "hi";'
  assert.equal(t1.lines.later, 1); // greet line replaced in turn 2
  assert.equal(t2.cancelled, true);
  assert.equal(t1.start, ms(0));
  assert.equal(t1.end, ms(9));
});

test('codex (modern dialect): items, failed patches, aborted turns, subagents skipped', async () => {
  const dir = tmpdir('codex');
  const file = writeJsonl(path.join(dir, 'rollout-2026-11-01T10-00-00-abc.jsonl'), [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'abc', cwd: '/repo', source: 'vscode' } },
    { timestamp: iso(0), type: 'turn_context', payload: { turn_id: 'T1', model: 'gpt-6-astra', cwd: '/repo' } },
    { timestamp: iso(1), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1', item: { type: 'UserMessage', id: 'U1', content: [{ type: 'text', text: '<environment_context>x</environment_context>' }, { type: 'text', text: 'make the tests pass' }] } } },
    { timestamp: iso(3), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1', item: { type: 'CommandExecution', status: 'failed', exit_code: 1 } } },
    { timestamp: iso(4), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1', item: { type: 'FileChange', status: 'completed', changes: { '/repo/a.py': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x = 1\n+x = 2' } } } } },
    { timestamp: iso(5), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script failed\napply_patch verification failed: no match' }], internal_chat_message_metadata_passthrough: { turn_id: 'T1' } } },
    { timestamp: iso(6), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T1', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Fixed.' }] } } },
    { timestamp: iso(7), type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: iso(10), type: 'turn_context', payload: { turn_id: 'T2', model: 'gpt-6-astra' } },
    { timestamp: iso(10), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'T2', item: { type: 'UserMessage', id: 'U2', content: [{ type: 'text', text: 'still failing' }] } } },
    { timestamp: iso(11), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'T2', reason: 'interrupted' } },
  ]);
  const [s] = await codex.parse(file);
  assert.deepEqual(kinds(s.events), ['prompt', 'tool:shell:error', 'tool:edit:ok', 'tool:edit:error', 'assistant', 'prompt', 'interrupt']);
  assert.equal(s.events[0].text, 'make the tests pass');
  const turns = buildTurns(s);
  assert.equal(turns[0].model, 'gpt-6-astra');
  assert.equal(turns[0].followUp, 'still failing');
  assert.equal(turns[0].tools.editErr, 1);
  assert.equal(turns[1].cancelled, true);

  const sub = writeJsonl(path.join(dir, 'rollout-sub.jsonl'), [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'sub', source: { subagent: { thread_spawn: { parent_thread_id: 'abc' } } } } },
  ]);
  assert.deepEqual(await codex.parse(sub), []);
});

test('codex (legacy dialect): user_message + function calls with exit codes', async () => {
  const dir = tmpdir('codex-legacy');
  const file = writeJsonl(path.join(dir, 'rollout-old.jsonl'), [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'old', cwd: '/r' } },
    { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { timestamp: iso(1), type: 'event_msg', payload: { type: 'user_message', message: 'run the build' } },
    { timestamp: iso(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["npm","run","build"]}' } },
    { timestamp: iso(3), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"output":"err","metadata":{"exit_code":2}}' } },
    { timestamp: iso(4), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: x.ts\n-old()\n+fixed()\n*** End Patch' } },
    { timestamp: iso(5), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM x.ts' } },
    { timestamp: iso(6), type: 'event_msg', payload: { type: 'agent_message', message: 'Build fixed.' } },
  ]);
  const [s] = await codex.parse(file);
  const turns = buildTurns(s);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].model, 'gpt-5-codex');
  assert.deepEqual(turns[0].tools, { calls: 2, shell: 1, shellErr: 1, edit: 1, editErr: 0, malformed: 0, rejected: 0 });
  assert.equal(turns[0].finalText, 'Build fixed.');
});

test('gemini: replays re-appended records, patches, rewinds as cancellations, shell exit codes', async () => {
  const dir = tmpdir('gemini');
  const file = writeJsonl(path.join(dir, 'proj', 'chats', 'session-2026-11-01T10-00-abcd1234.jsonl'), [
    { sessionId: 'g1', projectHash: 'h', startTime: iso(0), lastUpdated: iso(0), kind: 'main' },
    { id: 'm1', type: 'user', timestamp: iso(0), content: [{ text: 'fix the flaky test' }] },
    { id: 'm2', type: 'gemini', timestamp: iso(2), content: '', model: 'gemini-3-pro', toolCalls: [{ id: 'tc1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'scheduled' }] },
    { id: 'm2', type: 'gemini', timestamp: iso(2), content: '', model: 'gemini-3-pro', toolCalls: [{ id: 'tc1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', result: [{ functionResponse: { id: 'tc1', name: 'run_shell_command', response: { output: 'Output: fail\nExit Code: 1' } } }] }] },
    { id: 'm3', type: 'user', timestamp: iso(3), content: [{ functionResponse: { id: 'tc1', response: {} } }] },
    { id: 'm4', type: 'gemini', timestamp: iso(4), content: 'Patched it.', model: 'gemini-3-pro', toolCalls: [{ id: 'tc2', name: 'replace', args: { file_path: 'a.ts', old_string: 'retry(1)', new_string: 'retry(3)' }, status: 'error', result: [{ functionResponse: { id: 'tc2', response: { error: 'Failed to edit, 0 occurrences found' } } }] }] },
    { $set: { lastUpdated: iso(4) } },
    { id: 'm5', type: 'user', timestamp: iso(10), content: 'still flaky' },
    { id: 'm6', type: 'gemini', timestamp: iso(11), content: 'Let me', model: 'gemini-3-pro' },
    { $rewindTo: 'm5' },
    { id: 'm7', type: 'info', timestamp: iso(12), content: 'Request cancelled.' },
    { id: 'm8', type: 'user', timestamp: iso(20), content: '/stats' },
    { id: 'm9', type: 'user', timestamp: iso(21), content: 'ok try again' },
    { $patch: { updates: [{ id: 'm4', content: [{ text: 'Patched it (edited).' }] }] } },
  ]);
  const [s] = await gemini.parse(file);
  assert.deepEqual(kinds(s.events), ['prompt', 'assistant', 'tool:shell:error', 'assistant', 'tool:edit:error', 'prompt', 'interrupt', 'assistant', 'interrupt', 'prompt']);
  assert.equal(s.events[3].text, 'Patched it (edited).');
  const turns = buildTurns(s);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].followUp, 'still flaky');
  assert.equal(turns[1].cancelled, true);
});

test('fx (v2 log): prefs model, tool results, child-authored prompts, cancellations', async () => {
  const dir = tmpdir('fx');
  const file = writeJsonl(path.join(dir, 'sessions', 'v2', 'AbCdEfGhIjKl', 'log.jsonl'), [
    { v: 1, seq: 1, ts: ms(0), kind: 'session_created', id: 'AbCdEfGhIjKl', workspace: '/repo', role: 'root', host: 'app', crc: '0' },
    { v: 1, seq: 2, ts: ms(0), kind: 'set', key: 'prefs', value: { provider: 'gateway', model: 'google/gemini-neon' }, crc: '0' },
    { v: 1, seq: 3, ts: ms(1), kind: 'item', turn: 1, type: 'user', data: { text: 'speed up the build' }, crc: '0' },
    { v: 1, seq: 4, ts: ms(2), kind: 'item', turn: 1, type: 'tool_call', data: { call_id: 'c1', tool_name: 'shell', arguments_json: '{"action":"run","command":"make"}', argument_integrity: 'valid' }, crc: '0' },
    { v: 1, seq: 5, ts: ms(3), kind: 'item', turn: 1, type: 'tool_result', data: { call_id: 'c1', tool_name: 'shell', status: 'success', command_process_presentation: { exit_code: 2 } }, crc: '0' },
    { v: 1, seq: 6, ts: ms(4), kind: 'item', turn: 1, type: 'tool_call', data: { call_id: 'c2', tool_name: 'edit_file', arguments_json: '{bad', argument_integrity: 'malformed_json' }, crc: '0' },
    { v: 1, seq: 7, ts: ms(5), kind: 'item', turn: 1, type: 'assistant', data: { text: 'Done.' }, crc: '0' },
    { v: 1, seq: 8, ts: ms(6), kind: 'item', turn: 2, type: 'user', data: { text: 'report from child' }, crc: '0' },
    { v: 1, seq: 9, ts: ms(6), kind: 'item', turn: 2, type: 'author', data: { by: 'child' }, crc: '0' },
    { v: 1, seq: 10, ts: ms(10), kind: 'item', turn: 3, type: 'user', data: { text: 'not what I meant' }, crc: '0' },
    { v: 1, seq: 11, ts: ms(11), kind: 'item', turn: 3, type: 'interruption', data: { reason: 'cancelled' }, crc: '0' },
    { v: 1, seq: 12, ts: ms(11), kind: 'turn_interrupted', turn: 3, reason: 'cancel', crc: '0' },
    '{"v":1,"seq":13,"ts":1,"kind":"item","tur',
  ]);
  const [s] = await fx.parse(file);
  assert.deepEqual(kinds(s.events), ['prompt', 'tool:shell:error', 'tool:other:malformed', 'assistant', 'prompt', 'interrupt']);
  const turns = buildTurns(s);
  assert.equal(turns[0].model, 'google/gemini-neon');
  assert.equal(turns[0].followUp, 'not what I meant');
  assert.equal(turns[1].cancelled, true);
});

test('opencode: v1 sqlite, v2 sqlite, and JSON storage', async (t) => {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite not available');
    return;
  }
  const dir = tmpdir('opencode');
  const dbFile = path.join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, directory TEXT, time_created INT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INT, time_updated INT, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INT, data TEXT);
    CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, directory TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INT, time_created INT, data TEXT);
    CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INT, type TEXT, call_id TEXT, data TEXT);
  `);
  const ins = (sql, ...v) => db.prepare(sql).run(...v);
  ins('INSERT INTO session VALUES (?,?,?,?,?)', 'ses_1', 'p', null, '/repo', ms(0));
  ins('INSERT INTO session VALUES (?,?,?,?,?)', 'ses_child', 'p', 'ses_1', '/repo', ms(0));
  ins('INSERT INTO message VALUES (?,?,?,?,?)', 'msg_1', 'ses_1', ms(0), ms(0), JSON.stringify({ role: 'user', time: { created: ms(0) } }));
  ins('INSERT INTO part VALUES (?,?,?,?,?)', 'prt_1', 'msg_1', 'ses_1', ms(0), JSON.stringify({ type: 'text', text: 'add caching' }));
  ins('INSERT INTO message VALUES (?,?,?,?,?)', 'msg_2', 'ses_1', ms(1), ms(5), JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-5-5', providerID: 'anthropic', time: { created: ms(1), completed: ms(5) } }));
  ins('INSERT INTO part VALUES (?,?,?,?,?)', 'prt_2', 'msg_2', 'ses_1', ms(2), JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, metadata: { exit: 1 } } }));
  ins('INSERT INTO part VALUES (?,?,?,?,?)', 'prt_3', 'msg_2', 'ses_1', ms(3), JSON.stringify({ type: 'tool', tool: 'invalid', state: { status: 'completed', input: { tool: 'edit', error: 'bad' } } }));
  ins('INSERT INTO part VALUES (?,?,?,?,?)', 'prt_4', 'msg_2', 'ses_1', ms(4), JSON.stringify({ type: 'text', text: 'Added.' }));
  ins('INSERT INTO message VALUES (?,?,?,?,?)', 'msg_3', 'ses_1', ms(10), ms(10), JSON.stringify({ role: 'user', time: { created: ms(10) } }));
  ins('INSERT INTO part VALUES (?,?,?,?,?)', 'prt_5', 'msg_3', 'ses_1', ms(10), JSON.stringify({ type: 'text', text: 'please revert that' }));

  ins('INSERT INTO session_v2 VALUES (?,?,?,?)', 'ses_v2', 'p', null, '/repo2');
  ins('INSERT INTO session_message VALUES (?,?,?,?,?,?)', 'msg_a', 'ses_v2', 'user', 1, ms(0), JSON.stringify({ text: 'write docs', time: { created: ms(0) } }));
  ins('INSERT INTO session_message VALUES (?,?,?,?,?,?)', 'msg_b', 'ses_v2', 'assistant', 2, ms(1), JSON.stringify({ model: { id: 'gpt-6.1-sol', providerID: 'openai' }, content: [], error: { type: 'aborted', message: 'Step interrupted' }, time: { created: ms(1), completed: ms(3) } }));
  ins('INSERT INTO session_part VALUES (?,?,?,?,?,?)', 'msg_b', 'ses_v2', 0, 'tool', 'c1', JSON.stringify({ name: 'edit', state: { status: 'error', input: { path: 'a.md' }, error: { type: 'tool.input-json', message: 'bad json' } } }));
  ins('INSERT INTO session_message VALUES (?,?,?,?,?,?)', 'msg_c', 'ses_v2', 'idle', 3, ms(3), JSON.stringify({ outcome: 'interrupted' }));
  db.close();

  const sessions = await opencode.parse(dbFile);
  const v1 = sessions.find((s) => s.id === 'ses_1');
  const v2 = sessions.find((s) => s.id === 'ses_v2');
  assert.equal(sessions.length, 2); // child session skipped
  assert.deepEqual(kinds(v1.events), ['prompt', 'assistant', 'tool:shell:error', 'tool:other:malformed', 'prompt']);
  assert.equal(buildTurns(v1)[0].followUp, 'please revert that');
  assert.deepEqual(kinds(v2.events), ['prompt', 'assistant', 'tool:edit:malformed', 'interrupt', 'interrupt']);
  assert.equal(buildTurns(v2)[0].cancelled, true);

  // Generation A: JSON files.
  const st = path.join(dir, 'storage');
  writeJson(path.join(st, 'session', 'proj', 'ses_j.json'), { id: 'ses_j', directory: '/r' });
  writeJson(path.join(st, 'message', 'ses_j', 'msg_x.json'), { id: 'msg_x', role: 'user', time: { created: ms(0) } });
  writeJson(path.join(st, 'part', 'msg_x', 'prt_x.json'), { type: 'text', text: 'hello' });
  writeJson(path.join(st, 'message', 'ses_j', 'msg_y.json'), { id: 'msg_y', role: 'assistant', modelID: 'm', time: { created: ms(1) } });
  writeJson(path.join(st, 'part', 'msg_y', 'prt_y.json'), { type: 'text', text: 'hi' });
  const [js] = await opencode.parse(path.join(st, 'message', 'ses_j'));
  assert.deepEqual(kinds(js.events), ['prompt', 'assistant']);
});

test('parseUnit labels follow-ups', async () => {
  const dir = tmpdir('unit');
  const file = writeJsonl(path.join(dir, 'p', 's.jsonl'), [
    { type: 'user', uuid: 'a', timestamp: iso(0), message: { content: 'do x' } },
    { type: 'assistant', timestamp: iso(1), message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', uuid: 'b', timestamp: iso(5), message: { content: 'undo that' } },
  ]);
  const turns = await parseUnit('claude', file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].label, 'undo');
});
