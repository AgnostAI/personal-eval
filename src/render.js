// Render the scorecard as a terminal table and as a PNG that mirrors the
// black, monospace, hairline-grid look of the original screenshot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(here, '..', 'fonts');

function tableRows(card) {
  const header = ['Dimension', ...card.columns, ...(card.single ? [] : ['Edge'])];
  const body = card.rows
    .filter((r) => !(card.single && r.overall))
    .map((r) => [r.label, ...r.cells, ...(card.single ? [] : [r.edge])]);
  return { header, body };
}

const width = (s) => [...s].length;

export function renderTerminal(card, { color = false } = {}) {
  const { header, body } = tableRows(card);
  const all = [header, ...body];
  const w = header.map((_, c) => Math.max(...all.map((r) => width(r[c]))));
  const bold = (s) => (color ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const line = (l, m, r) => dim(l + w.map((x) => '─'.repeat(x + 2)).join(m) + r);
  const row = (cells, fmt = (s) => s) =>
    dim('│') + cells.map((c, i) => ` ${fmt(c)}${' '.repeat(w[i] - width(c))} `).join(dim('│')) + dim('│');
  const out = [line('┌', '┬', '┐'), row(header, bold)];
  for (const r of body) {
    out.push(line('├', '┼', '┤'));
    out.push(row(r));
  }
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSVG(card, { footer = 'npx personal-eval' } = {}) {
  const { header, body } = tableRows(card);
  const FS = 26; // font size
  const CW = FS * 0.6; // Geist Mono advance width
  const PADX = 24;
  const ROWH = 68;
  const MX = 96;
  const MT = 62;
  const MB = footer ? 96 : 75;
  const all = [header, ...body];
  const colW = header.map((_, c) => Math.ceil(Math.max(...all.map((r) => width(r[c]))) * CW + PADX * 2));
  const tableW = colW.reduce((a, b) => a + b, 0);
  const tableH = ROWH * all.length;
  const W = Math.round(tableW + MX * 2);
  const H = Math.round(tableH + MT + MB);
  const xs = [MX];
  for (const cw of colW) xs.push(xs[xs.length - 1] + cw);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="100%" height="100%" fill="#000"/>`);
  const stroke = 'stroke="#d4d4d4" stroke-width="1.5" shape-rendering="crispEdges"';
  parts.push(`<rect x="${MX}" y="${MT}" width="${tableW}" height="${tableH}" fill="none" ${stroke}/>`);
  for (let r = 1; r < all.length; r++) {
    const y = MT + r * ROWH;
    parts.push(`<line x1="${MX}" y1="${y}" x2="${MX + tableW}" y2="${y}" ${stroke}/>`);
  }
  for (let c = 1; c < colW.length; c++) {
    parts.push(`<line x1="${xs[c]}" y1="${MT}" x2="${xs[c]}" y2="${MT + tableH}" ${stroke}/>`);
  }
  all.forEach((cells, r) => {
    const y = MT + r * ROWH + ROWH / 2 + FS * 0.36;
    const weight = r === 0 ? 500 : 400;
    cells.forEach((text, c) => {
      parts.push(
        `<text x="${xs[c] + PADX}" y="${y}" font-family="Geist Mono" font-size="${FS}" font-weight="${weight}" fill="#fff" xml:space="preserve">${esc(text)}</text>`,
      );
    });
  });
  if (footer) {
    parts.push(
      `<text x="${MX + tableW}" y="${MT + tableH + 52}" text-anchor="end" font-family="Geist Mono" font-size="18" fill="#6b6b6b">${esc(footer)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/** Write a PNG (via resvg) or fall back to SVG. Returns the path written. */
export function writeImage(card, outPath, opts = {}) {
  const svg = renderSVG(card, opts);
  let Resvg;
  try {
    Resvg = createRequire(import.meta.url)('@resvg/resvg-js').Resvg;
  } catch {
    Resvg = null;
  }
  if (Resvg && !outPath.endsWith('.svg')) {
    const fontFiles = ['GeistMono-Regular.ttf', 'GeistMono-Medium.ttf'].map((f) => path.join(FONT_DIR, f));
    const png = new Resvg(svg, {
      font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Geist Mono' },
      fitTo: { mode: 'zoom', value: opts.scale || 1 },
    }).render().asPng();
    fs.writeFileSync(outPath, png);
    return outPath;
  }
  const svgPath = outPath.replace(/\.png$/i, '') + (outPath.endsWith('.svg') ? '' : '.svg');
  fs.writeFileSync(svgPath, svg);
  return svgPath;
}
