import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A fresh scratch dir per fixture, pinned to ESM by a sibling `package.json`
 *  — Node decides a `.ts` file's module kind from the nearest `package.json`,
 *  and an unpinned fixture can be loaded as CJS-via-require, which throws a
 *  require/ESM cycle error against the running test file. */
export async function withScratchDir<T>(
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'application-config-'));
  await writeFile(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `THRONE_LIVE_ROOT` (set globally by `npm test` to keep the suite hermetic
 * against the developer's own `config.user.ts`) short-circuits
 * `resolveLiveThroneRoot`'s git-based lookup outright. Tests that exercise
 * that git-based lookup itself must run with the override unset, or they'd
 * just be re-testing the override.
 */
export async function withoutThroneLiveRootOverride<T>(
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.THRONE_LIVE_ROOT;
  delete process.env.THRONE_LIVE_ROOT;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.THRONE_LIVE_ROOT;
    else process.env.THRONE_LIVE_ROOT = previous;
  }
}
