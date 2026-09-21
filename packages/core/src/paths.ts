/**
 * Where the library's own data lives.
 *
 * Everything sits under ONE directory — `data/` in the project root by default — so it
 * can be backed up, inspected, moved or deleted as a unit:
 *
 *   data/db/      title records, one JSON file each
 *   data/state/   watch history, My List, paired volumes
 *   data/cache/   TMDB responses, artwork, probe results
 *
 * The split matters: `db/` is derived and can be rebuilt by rescanning, `state/` is
 * yours and cannot. Nothing here regenerates `state/`, which is why watch history
 * survives a prune, a rescan, or deleting the database outright.
 *
 * NOTE: the data directory is deliberately NOT inside `src/`, and is gitignored. If
 * you replace the project folder wholesale rather than updating it, copy `data/`
 * across first — or set NFL_DATA_DIR somewhere outside the project.
 *
 * The root is found by MARKER, never by counting `..` — see findProjectRoot for the
 * bug that caused.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type DataPaths = {
  root: string;
  dbDir: string;
  stateDir: string;
  cacheDir: string;
  volumesFile: string;
  stateFile: string;
  capabilitiesFile: string;
};

/** The file that marks the workspace root, and exists in no other directory. */
const ROOT_MARKER = 'pnpm-workspace.yaml';

/**
 * Find the repository root by looking for `pnpm-workspace.yaml`, not by counting `..`.
 *
 * Counting was wrong, and wrong in the worst way — silently, and differently depending
 * on who asked. Three levels up lands on the root from `packages/core/src/`, which is
 * where the CLI runs this from. But the Electron main process BUNDLES `@nfl/core` into
 * `apps/desktop/out/main/`, and three levels up from there is `<repo>/apps`. So the app
 * wrote its library to `apps/data` while `pnpm scan` and `pnpm doctor` read `data/`,
 * and each reported confidently on a directory the other had never touched.
 *
 * Searching for a marker gives the same answer from any depth, which is the property
 * that was actually needed.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // The fallback keeps a checkout without the marker working rather than throwing.
  return findProjectRoot(here) ?? resolve(here, '..', '..', '..');
}

export function dataPaths(): DataPaths {
  const root =
    process.env.NFL_DATA_DIR ?? join(projectRoot(), 'data');

  const dbDir = process.env.NFL_DB_DIR ?? join(root, 'db');
  const stateDir = process.env.NFL_STATE_DIR ?? join(root, 'state');
  const cacheDir = process.env.NFL_CACHE_DIR ?? join(root, 'cache');

  return {
    root,
    dbDir,
    stateDir,
    cacheDir,
    volumesFile: join(stateDir, 'volumes.json'),
    stateFile: join(stateDir, 'progress.json'),
    capabilitiesFile: join(cacheDir, 'capabilities.json'),
  };
}

export async function ensureDataDirs(): Promise<DataPaths> {
  const p = dataPaths();
  await Promise.all([
    mkdir(join(p.dbDir, 'movies'), { recursive: true }),
    mkdir(join(p.dbDir, 'shows'), { recursive: true }),
    mkdir(p.stateDir, { recursive: true }),
    mkdir(join(p.cacheDir, 'tmdb'), { recursive: true }),
    mkdir(join(p.cacheDir, 'artwork'), { recursive: true }),
  ]);
  return p;
}
