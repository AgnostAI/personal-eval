import fs from 'node:fs/promises';
import path from 'node:path';

/** Recursively yield files under root matching `want`, skipping dirs matching `skipDir`. */
export async function* walk(root, want, skipDir = () => false) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (skipDir(p)) continue;
      yield* walk(p, want, skipDir);
    } else if (e.isFile() && want(p)) {
      yield p;
    }
  }
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
