/**
 * Content-derived identity.
 *
 * A file used to be identified by where it lived — volume plus relative path. Both
 * describe a *location*, so identity broke the moment the location was unwritable
 * (NTFS, optical, a NAS share), borrowed, renamed, or copied. Borrowed media is not an
 * edge case, and a design that only works on disks you own is the wrong design.
 *
 * Identity now comes from the bytes. Location becomes an observation — see `sightings`
 * on MediaFile — which means:
 *   - a borrowed drive is catalogued without ever being written to
 *   - copying a film onto your own drive recognises it instantly
 *   - the same film on two drives is one title with two sightings, not a duplicate
 *   - renames and cross-drive moves cost nothing
 *
 * The hash reads 2 MB regardless of file size: the head, the tail, and the length.
 * Head alone is unsafe because remuxes of the same source share container headers;
 * the tail differs whenever the content does. Duration is folded in as a cheap guard
 * that costs nothing, since ffprobe has already run.
 */

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** 1 MiB from each end. Enough to separate any two real files, cheap on an 80 GB one. */
const CHUNK = 1024 * 1024;

export async function computeContentId(
  path: string,
  sizeBytes: number,
  durationSec: number,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`${sizeBytes}:${Math.round(durationSec)}`);

  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, sizeBytes));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);

    // Only read a tail when the file is big enough for it to be distinct from the head.
    if (sizeBytes > CHUNK * 2) {
      const tail = Buffer.alloc(CHUNK);
      await handle.read(tail, 0, CHUNK, sizeBytes - CHUNK);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }

  // 128 bits is far beyond what a personal library can collide on, and keeps ids
  // short enough to read in a JSON file.
  return `c1-${hash.digest('hex').slice(0, 32)}`;
}

/**
 * Cheap change detection, unchanged in purpose from before: skip re-probing and
 * re-hashing a file whose size and mtime are identical. This is what keeps a warm
 * scan at a few hundred milliseconds.
 */
export function fingerprint(sizeBytes: number, mtimeMs: number): string {
  return `${sizeBytes}-${Math.floor(mtimeMs)}`;
}
