/**
 * Drive sidecar: `<libraryRoot>/.netflix-local/`
 *
 * Metadata describes *films*, not the machine that scanned them. Keeping it on the
 * drive means plugging that SSD into another Mac — or handing it to a friend — brings
 * the scan along, instead of re-probing a few hundred 80 GB files.
 *
 * The drive is the source of truth; the local store is a mirror. The mirror is what
 * makes an unplugged drive still render its tiles (ARCHITECTURE.md §8.5) — metadata
 * that lived *only* on the drive would vanish the moment you unplugged it, which is
 * precisely the state the availability model exists to handle.
 *
 * Deliberately NOT on the drive:
 *   - watch history and My List — handing someone a drive should not hand over your
 *     viewing history, and their resume points should not land in your Continue Watching
 *   - paired roots and mount paths — machine-specific by definition
 *   - cached trailers — tens of MB each, and re-downloadable
 *
 * The directory is dotted so the scanner's junk filter skips it automatically.
 */

import { access, constants, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TitleSchema, type Title } from '../schema/index.js';

export const SIDECAR_DIR = '.netflix-local';

export const VolumeIdentitySchema = z.object({
  version: z.literal(1),
  /**
   * The portable volume id.
   *
   * This is the load-bearing part of the whole design. `media[].volumeId` references
   * it, so if a second Mac generated a fresh id when pairing the same drive, every
   * title would point at a volume that machine has never heard of and the entire
   * library would resolve as "missing". Reusing the id from the drive is what makes
   * the metadata portable at all.
   */
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

export type VolumeIdentity = z.infer<typeof VolumeIdentitySchema>;

function sidecarPath(rootPath: string): string {
  return join(rootPath, SIDECAR_DIR);
}

function titlesDir(rootPath: string): string {
  return join(sidecarPath(rootPath), 'titles');
}

/** Can we write metadata here? Read-only drives and NAS shares fall back to mirror-only. */
export async function isWritable(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readVolumeIdentity(rootPath: string): Promise<VolumeIdentity | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(sidecarPath(rootPath), 'volume.json'), 'utf8'),
    );
    return VolumeIdentitySchema.parse(raw);
  } catch {
    return null;
  }
}

export async function writeVolumeIdentity(
  rootPath: string,
  identity: VolumeIdentity,
): Promise<boolean> {
  if (!(await isWritable(rootPath))) return false;
  try {
    await mkdir(sidecarPath(rootPath), { recursive: true });
    const target = join(sidecarPath(rootPath), 'volume.json');
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(identity, null, 2) + '\n', 'utf8');
    await rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a title to the drive, carrying only the media that actually live there.
 *
 * A title can span drives — a Theatrical cut on one SSD, an Extended on another. Each
 * drive should describe its own files and nothing else, so that plugging in one of
 * them does not assert the existence of files on a disk that is sitting in a drawer.
 */
export async function writeTitleToDrive(
  rootPath: string,
  volumeId: string,
  title: Title,
): Promise<boolean> {
  const media = title.media.filter((m) => m.sightings[0]?.volumeId === volumeId);
  if (media.length === 0) return false;

  try {
    await mkdir(titlesDir(rootPath), { recursive: true });
    const target = join(titlesDir(rootPath), `${title.id}.json`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...title, media }, null, 2) + '\n', 'utf8');
    await rename(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export async function readTitlesFromDrive(rootPath: string): Promise<Title[]> {
  const dir = titlesDir(rootPath);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('._'));
  } catch {
    return [];
  }

  const titles: Title[] = [];
  for (const file of files) {
    try {
      const parsed = TitleSchema.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
      if (parsed.success) titles.push(parsed.data);
    } catch {
      // A corrupt sidecar file is skipped, not fatal — the mirror may still have it.
    }
  }
  return titles;
}

/**
 * Merge a drive's copy of a title into whatever the mirror already holds.
 *
 * Media are unioned by (volumeId, relPath) so a title present on two drives keeps both
 * sets of files. Descriptive fields come from whichever copy was updated most recently,
 * except that a `confirmed` match always wins — a correction the user made by hand must
 * not be undone by a stale sidecar from another machine.
 */
export function mergeTitles(mine: Title | null, theirs: Title): Title {
  if (!mine) return theirs;

  const byKey = new Map(mine.media.map((m) => [`${m.sightings[0]?.volumeId}::${(m.sightings[0]?.relPath ?? "")}`, m]));
  for (const m of theirs.media) byKey.set(`${m.sightings[0]?.volumeId}::${(m.sightings[0]?.relPath ?? "")}`, m);
  const media = [...byKey.values()];

  const mineNewer = (mine.updatedAt ?? '') >= (theirs.updatedAt ?? '');
  const base = mine.matchState === 'confirmed' ? mine : mineNewer ? mine : theirs;

  return {
    ...base,
    media,
    // Keep the strongest match state either side has.
    matchState:
      mine.matchState === 'confirmed' || theirs.matchState === 'confirmed'
        ? 'confirmed'
        : base.matchState,
    externalIds: { ...theirs.externalIds, ...mine.externalIds },
    updatedAt: mineNewer ? mine.updatedAt : theirs.updatedAt,
  };
}
