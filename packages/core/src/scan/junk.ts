/**
 * Junk filtering for scene-release libraries on macOS-mounted drives.
 *
 * Two separate concerns, deliberately kept apart:
 *   - isJunkEntry      : never walk into / never consider at all
 *   - isSidecarText    : excluded from the media walk, but READ first for external IDs
 *
 * See ARCHITECTURE.md §7.2. The sidecar distinction matters: scene .nfo files usually
 * carry an IMDb URL, which converts a fuzzy title match into an exact one.
 */

export const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.m4v',
  '.avi',
  '.ts',
  '.m2ts',
  '.mov',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
]);

/** Files below this are samples, proofs, or stubs — never the feature. */
export const MIN_FEATURE_BYTES = 200 * 1024 * 1024;

/**
 * The floor for a file that names its own episode (`S01E01`).
 *
 * 200 MB suits films, but a 22-minute SD sitcom episode is often ~150 MB — under the
 * film floor, a whole season would be silently dropped as "no feature". An explicit
 * episode marker is strong evidence the file is real content, and samples are still
 * caught by name, so episodes get a floor that only screens out stubs and fragments.
 */
export const MIN_EPISODE_BYTES = 20 * 1024 * 1024;

const EPISODE_MARKER = /\bS\d{1,2}[\s._-]?E\d{1,3}(?!\d)/i;

/** Exact directory/file names that are always noise. */
const JUNK_NAMES = new Set([
  '.DS_Store',
  '.Spotlight-V100',
  '.fseventsd',
  '.Trashes',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
  '.apdisk',
  '$RECYCLE.BIN',
  'System Volume Information',
  '@eaDir',
  'lost+found',
]);

/** Directory names inside a release that never contain the feature. */
/**
 * Includes the extras folders Plex documents for a show or film folder. Without them a
 * featurette inside `Breaking Bad/Behind The Scenes/` has no episode number, so it is
 * ingested as a FILM with Breaking Bad's name on it. Keep ARCHITECTURE.md §7.2 in step.
 */
const JUNK_DIRS =
  /^(sample|samples|proof|screens|screenshots|extras|featurettes|subs|subtitles|bonus|behind[\s._-]?the[\s._-]?scenes|deleted[\s._-]?scenes|interviews|trailers)$/i;

/** Filename patterns that mark a video as not-the-feature. */
const NON_FEATURE_VIDEO =
  /(^|[.\s_-])(sample|trailer|extra|featurette|behind[.\s_-]?the[.\s_-]?scenes|deleted[.\s_-]?scenes?|interview|teaser)([.\s_-]|$)/i;

/** Sidecars we skip as media but parse for metadata before discarding. */
const SIDECAR_TEXT = /\.(nfo|txt|sfv|srr|md5)$/i;

/** AppleDouble resource forks, created on exFAT/FAT volumes by macOS. */
function isAppleDouble(name: string): boolean {
  return name.startsWith('._');
}

export function isJunkEntry(name: string): boolean {
  if (JUNK_NAMES.has(name)) return true;
  if (isAppleDouble(name)) return true;
  if (name.startsWith('.') && name !== '.') return true;
  return false;
}

export function isJunkDir(name: string): boolean {
  return isJunkEntry(name) || JUNK_DIRS.test(name);
}

export function isSidecarText(name: string): boolean {
  return SIDECAR_TEXT.test(name) && !isAppleDouble(name);
}

export function isVideoFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function looksLikeFeature(
  name: string,
  sizeBytes: number,
  minBytes: number = MIN_FEATURE_BYTES,
): boolean {
  if (!isVideoFile(name)) return false;
  // A caller that lowered the floor (tests, odd libraries) keeps its lower value.
  const floor = EPISODE_MARKER.test(name) ? Math.min(minBytes, MIN_EPISODE_BYTES) : minBytes;
  if (sizeBytes < floor) return false;
  if (NON_FEATURE_VIDEO.test(name)) return false;
  return true;
}

/** Strip the video extension, for use as a release name. */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
