import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByModel, scorecard } from '../src/metrics.js';
import { renderTerminal, renderSVG } from '../src/render.js';

function turn(model, over = {}) {
  return {
    agent: 'claude', session: over.session || 's', model, start: 0, end: 60_000, cancelled: false,
    followUp: 'next', label: 'none', finalText: 'ok', assistantMsgs: 1, interactive: true,
    tools: { calls: 10, shell: 5, shellErr: 0, edit: 5, editErr: 0, malformed: 0, rejected: 0 },
    lines: { added: 100, sameTurn: 0, later: 0 },
    ...over,
  };
}

test('scorecard: edges, ties, overall winner, formatting', () => {
  const turns = [];
  for (let i = 0; i < 100; i++) turns.push(turn('claude-opus-5-5', { label: i < 5 ? 'broken' : 'none', cancelled: i < 2 }));
  for (let i = 0; i < 50; i++) turns.push(turn('gpt-6-astra', { label: i < 1 ? 'broken' : 'none', end: 30_000 }));
  const groups = groupByModel(turns);
  const card = scorecard(groups, ['Opus 5.5', 'GPT-6 Astra']);
  const row = (label) => card.rows.find((r) => r.label.includes(label));

  assert.deepEqual(row('still broken').cells, ['5/100 (5.0%)', '1/50 (2.0%)']);
  assert.equal(row('still broken').edge, 'GPT-6 Astra');
  assert.deepEqual(row('Turns you cancelled').cells, ['2/100 (2.0%)', '0/50']);
  assert.equal(row('Not what I meant').edge, 'Tie'); // both 0
  assert.deepEqual(row('Median turn duration').cells, ['60 s', '30 s']);
  const overall = card.rows.at(-1);
  assert.equal(overall.label, 'Overall winner');
  assert.match(overall.edge, /^GPT-6 Astra/);

  const strict = scorecard(groups, ['Opus 5.5', 'GPT-6 Astra'], { strict: true });
  assert.equal(strict.rows.find((r) => r.label.includes('still broken')).edge, 'Tie'); // 5% vs 2% on n=150 isn't significant

  const text = renderTerminal(card);
  assert.match(text, /Dimension\s+│ Opus 5\.5/);
  const svg = renderSVG(card);
  assert.match(svg, /<svg[^>]+width="\d+"/);
  assert.match(svg, /Overall winner/);
});

test('single model: no Edge column', () => {
  const groups = groupByModel([turn('claude-opus-5-5')]);
  const card = scorecard(groups, ['Opus 5.5']);
  assert.equal(card.single, true);
  assert.doesNotMatch(renderTerminal(card), /Edge/);
});
