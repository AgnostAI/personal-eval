// Turn raw model ids into the short names people use: "claude-opus-5-5" -> "Opus 5.5".

const SPECIAL = { gpt: 'GPT', o: 'o' };

export function prettyModel(id) {
  if (!id) return 'unknown';
  let s = String(id).trim();
  s = s.replace(/^.*\//, ''); // provider prefixes: anthropic/, openai/, models/, …
  s = s.replace(/^(us|eu|apac|global)\.anthropic\./, '').replace(/^anthropic\./, '');
  s = s.replace(/-v\d+(:\d+)?$/, ''); // bedrock "-v1:0"
  s = s.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '').replace(/-latest$/, '');

  // Claude: claude-opus-5-5, claude-3-5-sonnet, claude-sonnet-4-5, claude-haiku-5-5
  let m = s.match(/^claude-(opus|sonnet|haiku|fable|mythos|instant)-(\d+)(?:[-.](\d))?(?:-(.+))?$/i);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ` ${words(m[4])}` : ''}`;
  m = s.match(/^claude-(\d+)(?:[-.](\d))?-(opus|sonnet|haiku)$/i);
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`;

  // OpenAI: gpt-6.1-sol, gpt-5-codex, o3-pro
  m = s.match(/^gpt-([\d.]+o?)(?:-(.+))?$/i);
  if (m) return `GPT-${m[1]}${m[2] ? ` ${words(m[2])}` : ''}`;
  m = s.match(/^(o\d)(?:-(.+))?$/i);
  if (m) return `${m[1]}${m[2] ? ` ${words(m[2])}` : ''}`;

  // Gemini: gemini-3-pro-preview, gemini-2.5-flash
  m = s.match(/^gemini-(.+)$/i);
  if (m) return `Gemini ${words(m[1])}`;

  return words(s);
}

function cap(w) {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function words(rest) {
  return rest
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (SPECIAL[w.toLowerCase()] ? SPECIAL[w.toLowerCase()] : /^\d/.test(w) ? w : cap(w)))
    .join(' ');
}
