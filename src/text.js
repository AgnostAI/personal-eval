// Shared text helpers: telling human prompts from harness-injected messages,
// tool-kind detection, and line extraction for edit tracking.

/** Messages that look like user turns but were written by the harness. */
const HARNESS_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook>',
  '<fork-boilerplate>',
  '<turn_aborted>',
  '<user_shell_command>',
  '<subagent_notification>',
  '<heartbeat>',
  '<automation',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  'Base directory for this skill:',
  '[SYSTEM NOTIFICATION',
  'Your response above was cut off',
  'Your response above was stopped',
  '[Request interrupted by user',
  'Continue where you left off.',
  'Continue from where you left off.',
  'personal-eval-judge:',
];

/** Wrapper blocks harnesses prepend to the real prompt; stripped before deciding. */
const WRAPPER_BLOCKS = [
  'system_instruction',
  'system-instruction',
  'environment_context',
  'user_instructions',
  'INSTRUCTIONS',
  'permissions instructions',
  'collaboration_mode',
  'skill',
  'system-reminder',
  'ide_selection',
  'ide_opened_file',
  'in-app-browser-context',
  'app-context',
];

const WRAPPER_RE = new RegExp(
  `<(${WRAPPER_BLOCKS.map((t) => t.replace(/[-]/g, '\\-')).join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`,
  'g',
);

/**
 * Return the human-written part of a user message, or null if the message
 * was injected by the harness (tool output, notifications, skill bodies…).
 */
export function humanText(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(WRAPPER_RE, '').trim();
  // Codex prepends AGENTS.md contents as a heading block.
  if (/^# AGENTS\.md instructions for /.test(text)) return null;
  if (!text) return null;
  for (const p of HARNESS_PREFIXES) if (text.startsWith(p)) return null;
  // Answers to the agent's multiple-choice questions: keep just what the user picked.
  const reply = text.match(/^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/);
  if (reply) {
    let answers = [];
    try {
      answers = JSON.parse(reply[1].trim()).map((a) => a?.answer).filter(Boolean);
    } catch {}
    return answers.length ? answers.join('\n') : null;
  }
  // Anything else that is one machine-written tag block (e.g. <foo>…</foo>) isn't typed by a person.
  if (/^<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*<\/\1>$/.test(text) && !/^<command-/.test(text)) return null;
  // Slash commands are human-initiated; keep the command and its args.
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    text = `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  // Pasted images are rendered as "[Image: …]" placeholders.
  text = text.replace(/\[Image[^\]]*\]/g, '').trim();
  return text || '[image]';
}

export function isInterruptText(raw) {
  return typeof raw === 'string' && /^\s*\[Request interrupted by user/.test(raw);
}

const SHELL_TOOLS = new Set([
  'bash', 'shell', 'run_shell_command', 'exec_command', 'local_shell', 'local_shell_call',
  'powershell', 'terminal', 'run_terminal_cmd', 'execute_command', 'run_command', 'container.exec',
]);
const EDIT_TOOLS = new Set([
  'edit', 'multiedit', 'write', 'notebookedit', 'str_replace_based_edit_tool', 'str_replace_editor',
  'apply_patch', 'replace', 'write_file', 'edit_file', 'create_file', 'patch', 'search_replace',
  'multi_edit', 'write_to_file', 'replace_in_file',
]);

export function toolKind(name) {
  const n = String(name || '').toLowerCase();
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (EDIT_TOOLS.has(n)) return 'edit';
  return 'other';
}

const REJECTED_RE =
  /doesn't want to proceed|tool use was rejected|user (rejected|denied|declined)|rejected by (the )?user|permission denied by (the )?user|was blocked by the user|user cancelled|aborted by user|operation was cancelled/i;
const MALFORMED_RE =
  /InputValidationError|Invalid tool parameters|No such tool available|is not a valid tool|unknown tool|tool .* not found|failed to parse (function |tool )?(call )?arguments|unsupported call|invalid (tool )?(arguments|params|parameters|input)\b|missing (required )?(field|parameter|argument)|unexpected (field|parameter|argument)|invalid json|params must have required property|must NOT have additional properties/i;

/** Classify a tool result that the harness flagged as an error. */
export function classifyToolError(text) {
  const t = String(text || '').slice(0, 2000);
  if (REJECTED_RE.test(t)) return 'rejected';
  if (MALFORMED_RE.test(t)) return 'malformed';
  return 'error';
}

export function isMalformedText(text) {
  return MALFORMED_RE.test(String(text || '').slice(0, 2000));
}
export function isRejectedText(text) {
  return REJECTED_RE.test(String(text || '').slice(0, 2000));
}

/** Lines worth tracking for churn: skip blanks and lone punctuation like "}" or ");". */
export function meaningfulLines(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length < 3) continue;
    if (!/[A-Za-z0-9]/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Turn a before/after pair into the lines actually removed and added,
 * cancelling unchanged lines (multiset difference).
 */
export function diffLines(before, after) {
  const a = meaningfulLines(before);
  const b = meaningfulLines(after);
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  const added = [];
  for (const l of b) {
    const c = counts.get(l) || 0;
    if (c > 0) counts.set(l, c - 1);
    else added.push(l);
  }
  const removed = [];
  for (const [l, c] of counts) for (let i = 0; i < c; i++) removed.push(l);
  return { removed, added };
}

/** Parse a unified diff body ("@@ … @@", "+x", "-y") into removed/added lines. */
export function unifiedDiffLines(diff) {
  const minus = [];
  const plus = [];
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) plus.push(line.slice(1));
    else if (line.startsWith('-')) minus.push(line.slice(1));
  }
  return diffLines(minus.join('\n'), plus.join('\n'));
}

/**
 * Parse an apply_patch envelope ("*** Begin Patch / *** Update File: …") into
 * per-file edits.
 */
export function applyPatchEdits(patch) {
  const edits = [];
  let cur = null;
  for (const line of String(patch || '').split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      cur = { path: m[2].trim(), op: m[1].toLowerCase(), minus: [], plus: [] };
      edits.push(cur);
      continue;
    }
    if (!cur || line.startsWith('***') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.plus.push(line.slice(1));
    else if (line.startsWith('-')) cur.minus.push(line.slice(1));
  }
  return edits.map((e) =>
    e.op === 'delete'
      ? { path: e.path, mode: 'delete', removed: [], added: [] }
      : { path: e.path, mode: 'patch', ...diffLines(e.minus.join('\n'), e.plus.join('\n')) },
  );
}

export function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}
