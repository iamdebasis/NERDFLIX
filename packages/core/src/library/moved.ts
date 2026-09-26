/**
 * Has a drive been reorganised since it was last scanned?
 *
 * The library knows where it last saw every file on every drive. When a folder is
 * created and films are moved into it — "a Cars folder, with the Cars films in it" —
 * those paths stop existing, and until a rescan finds the files again (by content, so
 * nothing about them is lost) Play fails and the drive's contents look incomplete.
 *
 * This answers only "has anything moved?" — the first miss is enough, because the
 * answer is to rescan, and the rescan says exactly what moved. Bounded in time, so a
 * slow NAS cannot hold up the library picker: running out of time means "don't know",
 * which is treated as "no".
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Title } from '../schema/index.js';

export async function hasMovedFiles(
  titles: readonly Title[],
  volumeId: string,
  rootPath: string,
  opts: { budgetMs?: number; concurrency?: number } = {},
): Promise<boolean> {
  const paths = titles.flatMap((t) =>
    t.media.flatMap((m) => m.sightings.filter((s) => s.volumeId === volumeId).map((s) => s.relPath)),
  );
  if (paths.length === 0) return false;

  const deadline = Date.now() + (opts.budgetMs ?? 1_500);
  let next = 0;
  let missing = false;

  const worker = async () => {
    while (!missing && next < paths.length && Date.now() < deadline) {
      const relPath = paths[next++];
      try {
        await access(join(rootPath, relPath));
      } catch {
        missing = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, paths.length) }, worker));
  return missing;
}
