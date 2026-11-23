// Parse every session file in parallel worker threads and return compact turns.
import os from 'node:os';
import fs from 'node:fs';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { READERS, getReader } from './readers/index.js';
import { buildTurns } from './turns.js';
import { classifyFollowUp } from './classify.js';

const SELF = fileURLToPath(import.meta.url);

/** Parse one unit (file or session dir) into turns with heuristic labels. */
export async function parseUnit(agent, unit) {
  const sessions = await getReader(agent).parse(unit);
  const turns = [];
  for (const s of sessions) {
    for (const t of buildTurns(s)) {
      t.label = t.followUp != null ? classifyFollowUp(t.followUp) : null;
      turns.push(t);
    }
  }
  return turns;
}

export async function discoverAll(agents) {
  const units = [];
  for (const id of agents) {
    const reader = READERS[id];
    if (!reader) continue;
    for (const unit of await reader.discover()) {
      let size = 0;
      try {
        size = fs.statSync(unit).size;
      } catch {}
      units.push({ agent: id, unit, size });
    }
  }
  return units;
}

/**
 * Run parseUnit over all units with a worker pool.
 * @param {{agent, unit, size}[]} units
 * @param {(done:number,total:number)=>void} onProgress
 */
export async function parseAll(units, onProgress = () => {}) {
  const queue = [...units].sort((a, b) => b.size - a.size); // big files first for balance
  const total = queue.length;
  const n = Math.max(1, Math.min((os.availableParallelism?.() ?? os.cpus().length) - 1, 8, total));
  const results = [];
  const errors = [];
  let done = 0;

  await Promise.all(
    Array.from({ length: n }, () =>
      new Promise((resolve) => {
        const worker = new Worker(SELF);
        const next = () => {
          const job = queue.shift();
          if (!job) {
            worker.terminate().then(resolve);
            return;
          }
          worker.current = job;
          worker.postMessage(job);
        };
        worker.on('message', (msg) => {
          if (msg.error) errors.push({ unit: worker.current.unit, error: msg.error });
          else for (const t of msg.turns) results.push(t);
          onProgress(++done, total);
          next();
        });
        worker.on('error', (err) => {
          errors.push({ unit: worker.current?.unit, error: String(err?.message || err) });
          onProgress(++done, total);
          resolve();
        });
        next();
      }),
    ),
  );
  return { turns: results, errors };
}

if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ agent, unit }) => {
    try {
      parentPort.postMessage({ turns: await parseUnit(agent, unit) });
    } catch (err) {
      parentPort.postMessage({ error: String(err?.message || err) });
    }
  });
}
