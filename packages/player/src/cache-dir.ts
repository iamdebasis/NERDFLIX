/**
 * Where the player keeps its own disposable caches.
 *
 * These used to sit in `~/.cache/netflix-local/` — outside the project, invisible, and
 * left behind by every uninstall. Everything the app writes now lives under one
 * directory it owns, so it can be backed up, inspected or deleted as a unit.
 *
 * This deliberately does NOT import `@nfl/core`, which owns the same resolution for
 * `db/` and `state/`. `@nfl/player` is the playback seam and has no dependencies; a
 * path string is not worth coupling it to the data layer for. The env var names are
 * shared, so the two cannot disagree about where the user pointed them.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_MARKER = 'pnpm-workspace.yaml';

/** By marker, never by counting `..` — see core's paths.ts for why that matters. */
function projectRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(here, '..', '..', '..');
}

/** The cache root, honouring the same overrides the rest of the app does. */
export function playerCacheDir(): string {
  if (process.env.NFL_CACHE_DIR) return process.env.NFL_CACHE_DIR;
  const data = process.env.NFL_DATA_DIR ?? join(projectRoot(), 'data');
  return join(data, 'cache');
}
