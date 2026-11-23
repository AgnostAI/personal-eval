// --judge: have Claude label each follow-up message instead of keyword rules.
// Uses the local `claude` CLI if present (works with a Claude subscription),
// otherwise the Anthropic API via ANTHROPIC_API_KEY. Results are cached so
// re-runs only label new messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { LABELS } from './classify.js';

const BATCH = 40;
const CONCURRENCY = 4;
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'personal-eval', 'judge-v1.json');

const SYSTEM = 'You label developer messages to a coding agent. Output only JSON.';

const INSTRUCTIONS = `personal-eval-judge: Each item is the end of a coding agent's reply ("agent") and the developer's next message ("next"). Label the developer's next message with exactly one label:

- not_meant: the agent misunderstood the request or did the wrong thing ("no, I meant…", "that's not what I asked", "wrong file")
- undo: asks to revert, remove or roll back something the agent just did
- redo: dislikes the result and wants it done again or differently, without saying it's broken ("I don't like it", "try again", "make it cleaner")
- broken: reports the agent's work doesn't work or is still failing (errors, crashes, "still broken", pasted stack traces)
- nudge: the agent stopped or replied empty and the developer just prods it on ("continue", "?", "go on")
- none: anything else, including new tasks, answers to the agent's questions, approvals, and follow-up requests

Return {"labels":[{"i":<item index>,"label":"<label>"}]} with one entry per item.

Items:
`;

const SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, label: { type: 'string', enum: LABELS } },
        required: ['i', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
};

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

const keyOf = (model, t) =>
  crypto.createHash('sha1').update(`${model}\0${t.finalText || ''}\0${t.followUp}`).digest('hex').slice(0, 20);

function hasClaudeCli() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export async function judgeTurns(turns, { model, log, status }) {
  const provider = hasClaudeCli() ? 'cli' : process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'api' : null;
  if (!provider) {
    log('--judge needs the `claude` CLI (Claude Code) or ANTHROPIC_API_KEY. Falling back to keyword rules.');
    return;
  }
  const modelId = model || (provider === 'api' ? 'claude-opus-5-5' : null);
  const cache = loadCache();
  const cacheModel = modelId || 'cli-default';
  const todo = [];
  for (const t of turns) {
    const k = keyOf(cacheModel, t);
    if (cache[k]) t.label = cache[k];
    else todo.push([k, t]);
  }
  if (!todo.length) return;

  log(`Labeling ${todo.length} follow-up messages with Claude (${provider === 'cli' ? 'claude CLI' : `API, ${modelId}`}). Only short snippets are sent: the agent reply's last 240 chars and your message's first 360.`);
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let done = 0;
  let failed = 0;
  const run = async (batch) => {
    const items = batch.map(([, t], i) => ({
      i,
      agent: (t.finalText || '').slice(-240),
      next: String(t.followUp).slice(0, 360),
    }));
    const prompt = INSTRUCTIONS + items.map((x) => JSON.stringify(x)).join('\n');
    try {
      const out = provider === 'cli' ? await callCli(prompt, modelId) : await callApi(prompt, modelId);
      for (const { i, label } of out.labels || []) {
        const entry = batch[i];
        if (!entry || !LABELS.includes(label)) continue;
        entry[1].label = label;
        cache[entry[0]] = label;
      }
    } catch (err) {
      failed++;
      if (failed === 1) log(`  judge call failed (${String(err.message || err).slice(0, 200)}); those messages keep their keyword labels.`);
    }
    done += batch.length;
    status(`Labeling follow-ups… ${done}/${todo.length}`);
  };
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await run(queue.shift());
  }));
  saveCache(cache);
}

function extractJSON(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in judge reply');
  return JSON.parse(s.slice(a, b + 1));
}

function callCli(prompt, model) {
  // Strip everything from the user's setup (MCP servers, settings, plugins, slash
  // commands, tools): without this one call can carry hundreds of thousands of tokens.
  const args = [
    '-p', '--no-session-persistence', '--output-format', 'json',
    '--system-prompt', SYSTEM, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
  ];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const d = JSON.parse(out);
        if (d.is_error) return reject(new Error(d.result || 'claude CLI error'));
        resolve(extractJSON(d.result));
      } catch (e) {
        reject(new Error(err.trim() || out.slice(0, 200) || `claude exited ${code}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function callApi(prompt, model) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('the Anthropic SDK is not installed (npm i @anthropic-ai/sdk)');
  }
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
    // If a safety classifier declines, let the server retry on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  if (res.stop_reason === 'refusal') throw new Error('request declined');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJSON(text);
}
