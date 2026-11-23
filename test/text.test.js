import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { humanText, diffLines, applyPatchEdits, unifiedDiffLines, classifyToolError } from '../src/text.js';
import { classifyFollowUp } from '../src/classify.js';
import { prettyModel } from '../src/models.js';
import { readLines } from '../src/lines.js';
import { tmpdir } from './helpers.js';

test('humanText keeps real prompts and drops harness messages', () => {
  assert.equal(humanText('fix the login bug'), 'fix the login bug');
  assert.equal(humanText('<task-notification><task-id>x</task-id></task-notification>'), null);
  assert.equal(humanText('<system-reminder>hi</system-reminder>'), null);
  assert.equal(humanText('Base directory for this skill: /x'), null);
  assert.equal(humanText('<system_instruction>\nYou are in Conductor\n</system_instruction>\n\nadd dark mode'), 'add dark mode');
  assert.equal(humanText('<system_instruction>only wrapper</system_instruction>'), null);
  assert.equal(humanText('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>pr 12</command-args>'), '/review pr 12');
  assert.equal(humanText('[Image: original 3024x1964, displayed at 1500x974] whats wrong here'), 'whats wrong here');
  assert.equal(humanText('# AGENTS.md instructions for /repo\n...'), null);
  assert.equal(humanText('<heartbeat>\n<automation_id>x</automation_id>\n</heartbeat>'), null);
  assert.equal(humanText('<in-app-browser-context source="ambient">\nstate\n</in-app-browser-context>\nwhy is this button grey?'), 'why is this button grey?');
  assert.equal(humanText('<send_user_message_question_reply>\n[{"question":"Which?","answer":"both"}]\n</send_user_message_question_reply>'), 'both');
  assert.equal(humanText('<some_new_harness_tag>\nblob\n</some_new_harness_tag>'), null);
});

test('diffLines cancels unchanged lines and ignores trivia', () => {
  const d = diffLines('const a = 1;\nconst b = 2;\n}\n', 'const a = 1;\nconst b = 3;\n}\n');
  assert.deepEqual(d, { removed: ['const b = 2;'], added: ['const b = 3;'] });
});

test('applyPatchEdits and unified diffs', () => {
  const edits = applyPatchEdits('*** Begin Patch\n*** Update File: a.py\n@@\n-x = 1\n+x = 2\n context\n*** Add File: b.py\n+print("hi")\n*** Delete File: c.py\n*** End Patch');
  assert.equal(edits.length, 3);
  assert.deepEqual(edits[0], { path: 'a.py', mode: 'patch', removed: ['x = 1'], added: ['x = 2'] });
  assert.deepEqual(edits[1].added, ['print("hi")']);
  assert.equal(edits[2].mode, 'delete');
  assert.deepEqual(unifiedDiffLines('@@ -1,2 +1,2 @@\n import os\n-old_line()\n+new_line()'), { removed: ['old_line()'], added: ['new_line()'] });
});

test('classifyToolError separates rejections and malformed calls', () => {
  assert.equal(classifyToolError("The user doesn't want to proceed with this tool use."), 'rejected');
  assert.equal(classifyToolError('<tool_use_error>InputValidationError: Edit failed</tool_use_error>'), 'malformed');
  assert.equal(classifyToolError('Exit code 1\nTraceback'), 'error');
});

test('classifyFollowUp', () => {
  const cases = {
    "no, i meant the settings page": 'not_meant',
    "that's not what I asked for": 'not_meant',
    'please revert that change': 'undo',
    'remove that, I did not want it': 'undo',
    "I don't like it, try a different approach": 'redo',
    'still broken, same error': 'broken',
    'it doesnt work': 'broken',
    'getting an error: TypeError x is undefined': 'broken',
    'continue': 'nudge',
    '?': 'nudge',
    'great, now add tests': 'none',
    'do not run the migrations yet': 'none',
    "that's not important, ship it": 'none',
  };
  for (const [text, label] of Object.entries(cases)) assert.equal(classifyFollowUp(text), label, text);
});

test('prettyModel', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(prettyModel('anthropic/claude-opus-4.8'), 'Opus 4.8');
  assert.equal(prettyModel('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(prettyModel('gpt-5-codex'), 'GPT-5 Codex');
  assert.equal(prettyModel('gemini-3-flash-preview'), 'Gemini 3 Flash Preview');
  assert.equal(prettyModel('o3'), 'o3');
});

test('readLines splits on \\n only, handles long lines, and skips by head', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'x.jsonl');
  const long = 'y'.repeat(3 << 20);
  fs.writeFileSync(f, `{"a":"x y"}\n{"skip":true,"pad":"${'z'.repeat(2 << 20)}"}\n{"b":"${long}"}\nlast`);
  const lines = [];
  for await (const l of readLines(f, { skip: (head) => head.startsWith('{"skip"') })) lines.push(l);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).a, 'x y');
  assert.equal(JSON.parse(lines[1]).b.length, long.length);
  assert.equal(lines[2], 'last');
});
