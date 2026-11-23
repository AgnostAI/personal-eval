import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { READERS } from './readers/index.js';
import { discoverAll, parseAll } from './pipeline.js';
import { groupByModel, scorecard } from './metrics.js';
import { renderTerminal, writeImage } from './render.js';

const pkg = createRequire(import.meta.url)('../package.json');

const HELP = `personal-eval ${pkg.version}
Which model actually works best for you? Reads the coding-agent sessions already
on your machine and scores each model on how often you had to correct it.
Nothing leaves your machine unless you pass --judge.

Usage: npx personal-eval [options]

  --models <a,b>     models to compare (substring of name or id, e.g. "opus,gpt-6")
                     default: your two most-used models
  --all              compare every model with enough turns (up to 6)
  --list             list the models found and exit
  --since <when>     only sessions after a date (2026-10-01) or age (30d, 12w)
  --agent <ids>      limit to agents: ${Object.keys(READERS).join(', ')}
  --project <text>   only sessions whose working directory contains <text>
  --min-turns <n>    minimum turns for a model to be eligible (default 30)
  --strict           call a row a tie unless the gap is statistically significant
  --judge            label follow-ups with Claude instead of keyword rules (more
                     accurate; sends follow-up snippets to Claude via your
                     ANTHROPIC_API_KEY or the local \`claude\` CLI)
  --judge-model <m>  model for --judge (default claude-opus-5-5 via API)
  --out <file>       image path (default ~/Downloads/personal-eval.png)
  --no-image         skip the image
  --json             print raw numbers as JSON
  -h, --help         show this help
  -v, --version      show version
`;

export function parseArgs(argv) {
  const o = { minTurns: 30, image: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    const flag = a.split('=')[0];
    switch (flag) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--models': o.models = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--all': o.all = true; break;
      case '--list': o.list = true; break;
      case '--since': o.since = parseSince(val()); break;
      case '--agent': case '--agents': o.agents = val().split(',').map((s) => s.trim().toLowerCase()); break;
      case '--project': o.project = val(); break;
      case '--min-turns': o.minTurns = Number(val()); break;
      case '--strict': o.strict = true; break;
      case '--judge': o.judge = true; break;
      case '--judge-model': o.judgeModel = val(); break;
      case '--out': o.out = val(); break;
      case '--no-image': o.image = false; break;
      case '--json': o.json = true; break;
      default: throw new Error(`unknown option ${a} (see --help)`);
    }
  }
  return o;
}

function parseSince(v) {
  const m = String(v).match(/^(\d+)\s*([dwmh])$/i);
  if (m) {
    const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2].toLowerCase()];
    return Date.now() - Number(m[1]) * unit;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`can't read --since ${v}`);
  return t;
}

function defaultOut() {
  const dl = path.join(os.homedir(), 'Downloads');
  return path.join(fs.existsSync(dl) ? dl : process.cwd(), 'personal-eval.png');
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void process.stdout.write(`${pkg.version}\n`);

  const tty = process.stderr.isTTY;
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const status = (s) => tty && process.stderr.write(`\r\x1b[2K${s}`);
  const log = (s = '') => process.stderr.write(`${s}\n`);

  const agents = opts.agents || Object.keys(READERS);
  for (const a of agents) if (!READERS[a]) throw new Error(`unknown agent "${a}" (have: ${Object.keys(READERS).join(', ')})`);

  status('Looking for sessions…');
  const units = await discoverAll(agents);
  if (!units.length) {
    status('');
    log('No coding-agent sessions found. Looked in:');
    for (const a of agents) for (const r of READERS[a].roots()) log(`  ${READERS[a].label.padEnd(12)} ${r}`);
    return 1;
  }
  const gb = units.reduce((s, u) => s + u.size, 0) / 1e9;
  const t0 = Date.now();
  const { turns: raw, errors } = await parseAll(units, (done, total) =>
    status(`Reading ${total} session files (${gb.toFixed(1)} GB)… ${Math.round((100 * done) / total)}%`),
  );
  status('');
  const readMs = Date.now() - t0;

  // Resumed/forked sessions copy history into new files: keep each prompt once.
  const seen = new Set();
  let turns = raw.filter((t) => {
    if (!t.key) return true;
    if (seen.has(t.key)) return false;
    seen.add(t.key);
    return true;
  });
  if (opts.since) turns = turns.filter((t) => t.start != null && t.start >= opts.since);
  if (opts.project) turns = turns.filter((t) => (t.cwd || '').includes(opts.project));

  const groups = groupByModel(turns);
  const ranked = [...groups.values()].sort((a, b) => b.turns.length - a.turns.length);

  if (opts.list) {
    log(`${'model'.padEnd(26)} ${'turns'.padStart(7)}  ${'sessions'.padStart(8)}  agents / ids`);
    for (const g of ranked) {
      const sessions = new Set(g.turns.map((t) => `${t.agent}:${t.session}`)).size;
      const agentLabels = [...g.agents].map((a) => READERS[a].label).join(', ');
      log(`${g.name.padEnd(26)} ${String(g.turns.length).padStart(7)}  ${String(sessions).padStart(8)}  ${agentLabels} · ${[...g.ids].join(', ')}`);
    }
    return 0;
  }

  let names;
  if (opts.models) {
    names = [];
    for (const q of opts.models) {
      const ql = q.toLowerCase();
      const hit = ranked.find((g) => !names.includes(g.name) && (g.name.toLowerCase().includes(ql) || [...g.ids].some((id) => id.toLowerCase().includes(ql))));
      if (!hit) throw new Error(`no model matching "${q}". Run with --list to see what was found.`);
      names.push(hit.name);
    }
  } else {
    const eligible = ranked.filter((g) => g.turns.length >= opts.minTurns);
    names = eligible.slice(0, opts.all ? 6 : 2).map((g) => g.name);
    if (!names.length && ranked.length) names = [ranked[0].name];
  }
  if (!names.length) {
    log('Found session files but no model turns in them.');
    return 1;
  }

  if (opts.judge) {
    const { judgeTurns } = await import('./judge.js');
    const chosen = turns.filter((t) => t.followUp != null && names.includes(groupName(t, groups)));
    await judgeTurns(chosen, { model: opts.judgeModel, log, status });
    status('');
  }

  const card = scorecard(groups, names, { strict: opts.strict });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
    return 0;
  }

  const metaLine = summaryLine(card, units, errors, readMs);
  process.stdout.write(`\n${metaLine}\n\n${renderTerminal(card, { color })}\n`);

  const notes = [];
  if (card.single) {
    notes.push(`Only one model has ${opts.minTurns}+ turns, so there's nothing to compare yet. Try --min-turns 10, --all, or --list.`);
  }
  const agentSets = card.meta.map((m) => m.agents.join('+'));
  if (!card.single && new Set(agentSets).size > 1) {
    notes.push(`These models ran in different agents (${card.meta.map((m) => `${m.name}: ${m.agents.map((a) => READERS[a].label).join(', ')}`).join('; ')}), so harness differences are part of the comparison.`);
  }
  const small = card.meta.filter((m) => m.followUps < 100);
  if (small.length) notes.push(`Small sample for ${small.map((m) => `${m.name} (${m.followUps} follow-ups)`).join(', ')}. Treat close rows as noise${opts.strict ? '' : ', or rerun with --strict'}.`);
  if (!opts.judge) notes.push('Follow-ups were labeled with keyword rules. Add --judge to have Claude label them.');
  if (errors.length) {
    const byReason = new Map();
    for (const e of errors) byReason.set(e.error, (byReason.get(e.error) || 0) + 1);
    const reasons = [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n}× ${r.slice(0, 120)}`);
    notes.push(`${errors.length} file(s) couldn't be read and were skipped: ${reasons.join('; ')}`);
  }
  for (const n of notes) process.stdout.write(`\n${color ? '\x1b[2m' : ''}• ${n}${color ? '\x1b[22m' : ''}`);
  process.stdout.write('\n');

  if (opts.image) {
    const out = path.resolve(opts.out || defaultOut());
    const written = writeImage(card, out);
    process.stdout.write(`\nSaved ${written}\n`);
  }
  return 0;
}

function groupName(turn, groups) {
  for (const g of groups.values()) if (g.ids.has(turn.model)) return g.name;
  return null;
}

function summaryLine(card, units, errors, ms) {
  const sessions = card.meta.reduce((s, m) => s + m.sessions, 0);
  const turns = card.meta.reduce((s, m) => s + m.turns, 0);
  const firsts = card.meta.map((m) => m.first).filter(Boolean);
  const lasts = card.meta.map((m) => m.last).filter(Boolean);
  const range = firsts.length ? `${fmtDate(Math.min(...firsts))} – ${fmtDate(Math.max(...lasts))}` : '';
  const agents = [...new Set(card.meta.flatMap((m) => m.agents))].map((a) => READERS[a].label).join(', ');
  return `personal-eval · ${turns.toLocaleString()} turns across ${sessions.toLocaleString()} sessions · ${range} · ${agents} · read ${units.length} files in ${(ms / 1000).toFixed(1)}s`;
}
