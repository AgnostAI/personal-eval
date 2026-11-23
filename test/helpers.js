import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir(name = 'pe') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

export function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

export const iso = (s) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
export const ms = (s) => Date.UTC(2026, 10, 1, 10, 0, s);
