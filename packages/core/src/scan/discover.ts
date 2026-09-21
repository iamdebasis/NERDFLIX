/**
 * Release-unit discovery. See ARCHITECTURE.md §7.1.
 *
 * A "release unit" is one feature video plus the scene name that describes it.
 * Two shapes occur in the wild:
 *
 *   1. Bare file at the root:
 *        Star.Wars.Episode.IV.A.New.Hope.1977.Hybrid.2160p.Remux.HEVC.DoVi.TrueHD.7.1-3L.mkv
 *
 *   2. Release folder containing one feature plus sidecar junk:
 *        John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX...-GHD[TGx]/
 *          ├─ [TGx]Downloaded from torrentgalaxy.to .txt
 *          ├─ John.Wick.Chapter.4...-GHD.mkv
 *          └─ NEW upcoming releases by Xclusive.txt
 *
 *   3. A CONTAINER holding several of the above, nested arbitrarily deep:
 *        MOVIEX/
 *          ├─ Cars.2006...-FraMeSToR/Cars.2006...mkv        release folder
 *          ├─ Star Wars Collection/                          container
 *          │    ├─ Rogue One ... -DDR/Rogue One ....mkv      release folder
 *          │    └─ Star.Wars.Episode.I....mkv                bare file
 *          └─ The.Dark.Knight.Rises....mkv                   bare file
 *
 * The folder name is preferred as the release name because scene folder names are
 * canonical and complete, while the file inside is sometimes truncated or renamed.
 *
 * SHAPE 3 IS WHY THIS RECURSES. It used to stop at one level: a folder holding more
 * than one feature was recorded as a `multiple-features` issue and skipped whole, on
 * the assumption that it was a multi-part release or a season pack. A folder called
 * "Star Wars Collection" with eight films in it therefore contributed nothing, and the
 * only way to see them was to pair that subfolder as a library of its own. Silently
 * discarding eight films is a far worse failure than the duplicate a genuine
 * multi-part release might produce, so the default is now to look inside.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isJunkDir,
  isJunkEntry,
  isSidecarText,
  isVideoFile,
  looksLikeFeature,
  stripExtension,
  MIN_FEATURE_BYTES,
} from './junk.js';

export type ReleaseUnit = {
  /** Absolute path to the feature video, or to the disc folder. */
  videoPath: string;
  /** Absolute path to the release root (folder, or the file itself if bare). */
  releaseRoot: string;
  /** The scene string we will parse. */
  releaseName: string;
  /** Where releaseName came from — folder names are more trustworthy. */
  nameSource: 'folder' | 'file';
  sizeBytes: number;
  mtimeMs: number;
  /** Sidecar .nfo/.txt paths, kept for external-ID extraction. */
  sidecars: string[];
  /** BDMV / VIDEO_TS rather than a single file. */
  discStructure: boolean;
};

export type DiscoveryIssue = {
  path: string;
  reason: 'multiple-features' | 'no-feature' | 'unreadable' | 'too-deep';
  detail?: string;
};

/**
 * How far to follow nested folders.
 *
 * Generous, because someone's library may be organised by decade, then by director,
 * then by film. Bounded, because a cycle of symlinks would otherwise walk forever and
 * a scan that never finishes looks exactly like a scan that crashed.
 */
export const MAX_CONTAINER_DEPTH = 8;

/**
 * Do these loose videos look like ONE release split into parts?
 *
 * The narrow case worth protecting: `Movie.CD1.mkv` / `Movie.CD2.mkv` is a single film
 * and must not become two. Recursing is right for everything else, so this only claims
 * a match when the names are identical apart from a part marker — which a folder of
 * different films never is.
 */
export function looksLikeMultiPart(names: string[]): boolean {
  if (names.length < 2) return false;
  const marker = /[._\s-]*(?:cd|disc|disk|part|pt)[._\s-]*\d{1,2}$/i;
  const stems = names.map((n) => stripExtension(n));
  if (!stems.every((s) => marker.test(s))) return false;
  const bases = new Set(stems.map((s) => s.replace(marker, '').toLowerCase()));
  // Identical apart from the marker — otherwise they are simply different films.
  return bases.size === 1;
}

export type DiscoverOptions = {
  /** Override the feature-size floor. Only useful for tests and odd libraries. */
  minFeatureBytes?: number;
};

export type DiscoveryResult = {
  units: ReleaseUnit[];
  issues: DiscoveryIssue[];
};

type FoundVideo = {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  /** 0 = directly inside the folder being judged. Used to tell a release from a shelf. */
  depth: number;
};

/**
 * Does this folder name describe the film inside it?
 *
 * The question that separates a RELEASE FOLDER from a SHELF, and it cannot be answered
 * by counting files. `Cars.2006...-FraMeSToR/` holding one film is a release; `Ridley
 * Scott/` holding one film is a shelf that happens to be short today, and naming the
 * title after it would produce a film called "Ridley Scott". Scene releases name the
 * folder and the file the same thing — sometimes with a tracker tag glued on the end —
 * so a prefix relation between the two is the signal.
 *
 * The length floor stops a coincidence: two short strings sharing a few letters is not
 * evidence of anything.
 */
export function folderDescribesFile(folderName: string, fileStem: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(folderName);
  const b = norm(fileStem);
  if (a.length < 8 || b.length < 8) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Walk a release folder looking for the feature. Depth-limited; junk-aware. */
async function findFeatures(
  dir: string,
  depth: number,
  maxDepth: number,
  out: FoundVideo[],
  discMarkers: string[],
  minBytes: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);

    if (entry.isDirectory()) {
      if (name === 'BDMV' || name === 'VIDEO_TS') {
        discMarkers.push(full);
        continue;
      }
      if (isJunkDir(name)) continue;
      if (depth < maxDepth) {
        await findFeatures(full, depth + 1, maxDepth, out, discMarkers, minBytes);
      }
      continue;
    }

    if (isJunkEntry(name)) continue;
    if (!isVideoFile(name)) continue;

    try {
      const s = await stat(full);
      if (looksLikeFeature(name, s.size, minBytes)) {
        out.push({ path: full, name, sizeBytes: s.size, mtimeMs: s.mtimeMs, depth });
      }
    } catch {
      /* unreadable, skip */
    }
  }
}

/** Collect sidecar text files at the top level of a release folder. */
async function findSidecars(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isSidecarText(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Sidecars for a BARE video file: same directory, same stem, different extension.
 *
 * Stem matching is essential rather than convenient. A root holding several bare
 * releases plus one stray .nfo would otherwise attach that file's IMDb ID to every
 * title in the folder, silently mis-matching all of them.
 */
async function findSiblingSidecars(dir: string, stem: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isSidecarText(e.name) && stripExtension(e.name) === stem)
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function discoverReleaseUnits(
  root: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const result = await discoverIn(root, opts, 0, new Set());
  result.units.sort((a, b) => a.releaseName.localeCompare(b.releaseName));
  return result;
}

async function discoverIn(
  root: string,
  opts: DiscoverOptions,
  depth: number,
  visited: Set<string>,
): Promise<DiscoveryResult> {
  const minBytes = opts.minFeatureBytes ?? MIN_FEATURE_BYTES;
  const units: ReleaseUnit[] = [];
  const issues: DiscoveryIssue[] = [];

  if (depth > MAX_CONTAINER_DEPTH) {
    return { units, issues: [{ path: root, reason: 'too-deep' }] };
  }
  /*
   * Follow each real directory once. A symlink pointing back up its own tree would
   * otherwise recurse until the process died, and on a NAS share that is not exotic.
   */
  let key = root;
  try {
    key = String((await stat(root)).ino) || root;
  } catch {
    /* fall back to the path, which is still better than nothing */
  }
  if (visited.has(key)) return { units, issues };
  visited.add(key);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      units,
      issues: [{ path: root, reason: 'unreadable', detail: String(err) }],
    };
  }

  for (const entry of entries) {
    const name = entry.name;
    const full = join(root, name);

    if (isJunkEntry(name)) continue;

    // Shape 1: bare video file at the root.
    if (entry.isFile()) {
      if (!isVideoFile(name)) continue;
      try {
        const s = await stat(full);
        if (!looksLikeFeature(name, s.size, minBytes)) continue;
        const stem = stripExtension(name);
        units.push({
          videoPath: full,
          releaseRoot: full,
          releaseName: stem,
          nameSource: 'file',
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
          sidecars: await findSiblingSidecars(root, stem),
          discStructure: false,
        });
      } catch (err) {
        issues.push({ path: full, reason: 'unreadable', detail: String(err) });
      }
      continue;
    }

    if (!entry.isDirectory()) continue;
    if (isJunkDir(name)) continue;

    // Shape 2: release folder.
    const found: FoundVideo[] = [];
    const discMarkers: string[] = [];
    await findFeatures(full, 0, 2, found, discMarkers, minBytes);

    /*
     * A release folder is a NARROW case: one feature, sitting directly inside, whose
     * name the folder describes. Everything else is a shelf and gets looked into.
     *
     * Both extra conditions were learned from real trees. Without the depth check,
     * `1980s/Sci-Fi/Ridley Scott/Blade.Runner.mkv` made a film called "1980s" — the
     * feature was found two levels down and the top folder claimed it. Without the
     * name check, the same film in a director folder became "Ridley Scott".
     */
    const single = found.length === 1 ? found[0] : null;
    const isReleaseFolder =
      single !== null && single.depth === 0 && folderDescribesFile(name, stripExtension(single.name));

    if (isReleaseFolder) {
      const v = single;
      units.push({
        videoPath: v.path,
        releaseRoot: full,
        releaseName: name, // folder name wins
        nameSource: 'folder',
        sizeBytes: v.sizeBytes,
        mtimeMs: v.mtimeMs,
        sidecars: await findSidecars(full),
        discStructure: false,
      });
    } else if (found.length === 1) {
      // One film, but this folder is a shelf rather than its release. Look inside, and
      // the file will be picked up on its own terms.
      const nested = await discoverIn(full, opts, depth + 1, visited);
      units.push(...nested.units);
      issues.push(...nested.issues);
    } else if (found.length > 1 && looksLikeMultiPart(found.map((f) => f.name))) {
      // One film split across files. Two titles would be worse than a review note.
      issues.push({
        path: full,
        reason: 'multiple-features',
        detail: `${found.length} parts: ${found.map((f) => f.name).join(', ')}`,
      });
    } else if (found.length > 1) {
      /*
       * A CONTAINER: several different films under one folder. Look inside rather
       * than discarding it — see the note at the top of this file.
       */
      const nested = await discoverIn(full, opts, depth + 1, visited);
      units.push(...nested.units);
      issues.push(...nested.issues);
    } else if (discMarkers.length > 0) {
      const s = await stat(full);
      units.push({
        videoPath: discMarkers[0],
        releaseRoot: full,
        releaseName: name,
        nameSource: 'folder',
        sizeBytes: 0,
        mtimeMs: s.mtimeMs,
        sidecars: await findSidecars(full),
        discStructure: true,
      });
    } else {
      /*
       * Nothing within two levels. That is not proof of nothing at all — a library
       * organised by decade or by director hides its films deeper — so look, and only
       * report an empty folder if the search really comes back empty.
       */
      const nested = await discoverIn(full, opts, depth + 1, visited);
      if (nested.units.length === 0 && nested.issues.length === 0) {
        issues.push({ path: full, reason: 'no-feature' });
      } else {
        units.push(...nested.units);
        issues.push(...nested.issues);
      }
    }
  }

  return { units, issues };
}
