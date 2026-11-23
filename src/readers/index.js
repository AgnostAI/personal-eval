import * as claude from './claude.js';
import * as codex from './codex.js';
import * as gemini from './gemini.js';
import * as opencode from './opencode.js';
import * as fx from './fx.js';

export const READERS = { claude, codex, gemini, opencode, fx };

export function getReader(id) {
  const r = READERS[id];
  if (!r) throw new Error(`unknown agent "${id}"`);
  return r;
}
