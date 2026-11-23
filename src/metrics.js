// Score each model on the same dimensions as the table people share:
// how often you had to correct it, how often its tools failed, and how much of
// its own code got thrown away. Lower is better on every row.
import { prettyModel } from './models.js';

const CORRECTION = new Set(['not_meant', 'broken', 'undo']);

/** Group turns by display model name. */
export function groupByModel(turns) {
  const groups = new Map();
  for (const t of turns) {
    const name = prettyModel(t.model);
    if (!groups.has(name)) groups.set(name, { name, ids: new Set(), agents: new Set(), turns: [] });
    const g = groups.get(name);
    g.ids.add(t.model);
    g.agents.add(t.agent);
    g.turns.push(t);
  }
  return groups;
}

function stats(turns) {
  const s = {
    turns: turns.length,
    followUps: 0,
    not_meant: 0, undo: 0, redo: 0, broken: 0,
    interactiveFollowUps: 0, interactiveCorrections: 0,
    cancelled: 0,
    edit: 0, editErr: 0, shell: 0, shellErr: 0,
    calls: 0, malformed: 0,
    emptyReplies: 0, replied: 0,
    added: 0, sameTurn: 0, later: 0,
    durations: [],
    sessions: new Set(),
    first: Infinity, last: -Infinity,
  };
  for (const t of turns) {
    s.sessions.add(`${t.agent}:${t.session}`);
    if (t.start != null) {
      s.first = Math.min(s.first, t.start);
      s.last = Math.max(s.last, t.start);
    }
    if (t.cancelled) s.cancelled++;
    s.edit += t.tools.edit;
    s.editErr += t.tools.editErr;
    s.shell += t.tools.shell;
    s.shellErr += t.tools.shellErr;
    s.calls += t.tools.calls;
    s.malformed += t.tools.malformed;
    s.added += t.lines.added;
    s.sameTurn += t.lines.sameTurn;
    s.later += t.lines.later;
    if (t.followUp != null) {
      s.followUps++;
      if (t.label && t.label in s) s[t.label]++;
      if (t.interactive) {
        s.interactiveFollowUps++;
        if (CORRECTION.has(t.label)) s.interactiveCorrections++;
      }
      if (!t.cancelled) {
        s.replied++;
        // The model's last message had no text and no tool call: it just stopped.
        if (t.assistantMsgs > 0 && !t.finalText && !t.endedOnTool) s.emptyReplies++;
      }
    }
    if (!t.cancelled && t.assistantMsgs > 0 && t.end != null && t.start != null) {
      const d = (t.end - t.start) / 1000;
      if (d >= 0 && d < 6 * 3600) s.durations.push(d);
    }
  }
  return s;
}

const pct = (n, d, digits = 1) => {
  const v = (100 * n) / d;
  if (n > 0 && v < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}%`;
  return `${v.toFixed(digits)}%`;
};
const ratio = (n, d) => (n === 0 ? `0/${d}` : `${n}/${d} (${pct(n, d)})`);
const countRate = (n, d) => (n === 0 ? '0' : `${n} (${pct(n, d, (100 * n) / d < 1 ? 2 : 1)})`);

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function fmtDuration(sec) {
  if (sec == null) return '–';
  if (sec < 600) return `${Math.round(sec)} s`;
  if (sec < 7200) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/** Row definitions, in the order of the original table. */
const ROWS = [
  { label: '"Not what I meant" follow-ups', n: 'not_meant', d: 'followUps', fmt: ratio },
  { label: '"Undo / remove that" follow-ups', n: 'undo', d: 'followUps', fmt: ratio },
  { label: '"Don\'t like it, redo" follow-ups', n: 'redo', d: 'followUps', fmt: ratio },
  { label: '"It\'s broken / still broken" follow-ups', n: 'broken', d: 'followUps', fmt: ratio },
  {
    label: 'Intent + broken + undo, interactive work only',
    n: 'interactiveCorrections', d: 'interactiveFollowUps',
    fmt: (n, d) => pct(n, d, 0),
  },
  { label: 'Turns you cancelled', n: 'cancelled', d: 'turns', fmt: ratio },
  { label: 'Failed file edits', n: 'editErr', d: 'edit', fmt: ratio },
  { label: 'Failed shell commands', n: 'shellErr', d: 'shell', fmt: ratio },
  { label: 'Empty replies needing a nudge', n: 'emptyReplies', d: 'replied', fmt: countRate },
  { label: 'Malformed tool calls', n: 'malformed', d: 'calls', fmt: countRate },
  { label: 'Own lines rewritten within the same turn', n: 'sameTurn', d: 'added', fmt: (n, d) => pct(n, d) },
  { label: 'Own lines removed in a later turn', n: 'later', d: 'added', fmt: (n, d) => pct(n, d) },
  { label: 'Median turn duration', duration: true },
];

/**
 * Two-proportion z-test p-value (two-sided). Used by --strict to call a row a
 * tie when the gap could be noise.
 */
function pTwoProp(n1, d1, n2, d2) {
  if (!d1 || !d2) return 1;
  const p = (n1 + n2) / (d1 + d2);
  const se = Math.sqrt(p * (1 - p) * (1 / d1 + 1 / d2));
  if (!se) return n1 / d1 === n2 / d2 ? 1 : 0;
  const z = Math.abs(n1 / d1 - n2 / d2) / se;
  return 2 * (1 - normCdf(z));
}
function normCdf(z) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

/**
 * Build the scorecard for the chosen models.
 * @returns {{ columns: string[], rows: {label, cells, edge, winner}[], summary, meta }}
 */
export function scorecard(groups, names, { strict = false, minSample = 1 } = {}) {
  const S = names.map((n) => stats(groups.get(n).turns));
  const edges = new Map(names.map((n) => [n, 0]));
  let ties = 0;
  const rows = [];

  for (const row of ROWS) {
    let values;
    let cells;
    if (row.duration) {
      values = S.map((s) => median(s.durations));
      cells = values.map(fmtDuration);
    } else {
      values = S.map((s) => (s[row.d] >= minSample && s[row.d] > 0 ? s[row.n] / s[row.d] : null));
      cells = S.map((s, i) => (values[i] == null ? '–' : row.fmt(s[row.n], s[row.d])));
    }
    const valid = values.map((v, i) => [v, i]).filter(([v]) => v != null);
    let edge = '–';
    let winner = null;
    if (valid.length >= 2) {
      valid.sort((a, b) => a[0] - b[0]);
      const [best, bi] = valid[0];
      const [second, si] = valid[1];
      let tie = best === second || cells[bi] === cells[si];
      if (!tie && strict) {
        if (row.duration) tie = second > 0 && (second - best) / second < 0.1;
        else tie = pTwoProp(S[bi][row.n], S[bi][row.d], S[si][row.n], S[si][row.d]) >= 0.05;
      }
      if (tie) {
        edge = 'Tie';
        ties++;
      } else {
        winner = names[bi];
        edge = winner;
        edges.set(winner, edges.get(winner) + 1);
      }
    }
    rows.push({ label: row.label, cells, edge, winner });
  }

  // Overall winner row.
  const ranked = [...edges.entries()].sort((a, b) => b[1] - a[1]);
  const plural = (n) => `${n} edge${n === 1 ? '' : 's'}`;
  const cells = names.map((n) => `${plural(edges.get(n))}${ties && ranked[0][0] === n ? `, ${ties} tie${ties === 1 ? '' : 's'}` : ''}`);
  let verdict = 'Tie';
  if (names.length >= 2 && ranked[0][1] > ranked[1][1]) {
    const margin = ranked[0][1] - ranked[1][1];
    verdict = margin <= 2 ? `${ranked[0][0]}, narrowly` : ranked[0][0];
  }
  if (names.length === 1) verdict = '–';
  rows.push({ label: 'Overall winner', cells, edge: verdict, winner: verdict === 'Tie' ? null : ranked[0][0], overall: true });

  const meta = names.map((n, i) => ({
    name: n,
    ids: [...groups.get(n).ids],
    agents: [...groups.get(n).agents],
    turns: S[i].turns,
    sessions: S[i].sessions.size,
    followUps: S[i].followUps,
    first: Number.isFinite(S[i].first) ? S[i].first : null,
    last: Number.isFinite(S[i].last) ? S[i].last : null,
  }));
  return { columns: names, rows, meta, single: names.length === 1 };
}
