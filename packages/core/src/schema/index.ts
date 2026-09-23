/**
 * The data contract. See ARCHITECTURE.md §5.
 *
 * These schemas are the reason the agent-writes-JSON workflow is safe: a malformed
 * edit produces a loud validation failure at load time rather than a blank screen or,
 * worse, a silently wrong library.
 */

import { z } from 'zod';

export const HdrFormatSchema = z.enum(['SDR', 'HDR10', 'HDR10+', 'HLG', 'DV']);

export const AudioTrackSchema = z.object({
  codec: z.string(),
  channels: z.number().int().nonnegative(),
  lang: z.string().optional(),
  title: z.string().optional(),
  bitrateKbps: z.number().optional(),
  /** The container's default disposition — what a player picks when told nothing. */
  isDefault: z.boolean().default(false),
  /**
   * TrueHD/E-AC3 with an object layer. macOS cannot bitstream these, so they decode
   * to a PCM bed and the object metadata is lost — the UI must say so honestly.
   */
  objectAudio: z.boolean().default(false),
});

export const SubtitleTrackSchema = z.object({
  lang: z.string().optional(),
  /**
   * The track's own name. Without it a disc's twenty-five subtitle tracks collapse to
   * a list of languages where "English" appears twice and only one is SDH.
   */
  title: z.string().optional(),
  format: z.string(),
  forced: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});

export const ChapterSchema = z.object({
  title: z.string(),
  startSec: z.number().nonnegative(),
});

/**
 * Somewhere this exact file has been observed.
 *
 * A file is not *on* a volume — it has *been seen* on volumes. One media entry can
 * have several sightings: the same film on two drives, or on a borrowed disk and then
 * on your own after copying it.
 */
export const SightingSchema = z.object({
  volumeId: z.string(),
  /** Path relative to that volume's library root. */
  relPath: z.string(),
  /**
   * size + mtime AT THIS LOCATION. Belongs here, not on the media entry: copying a
   * film gives the copy a new mtime while the content is identical, so a per-media
   * fingerprint would make every copy look like a modification.
   */
  fingerprint: z.string().default(''),
  lastSeen: z.string(),
});

export const MediaFileSchema = z.object({
  /**
   * Derived from the bytes, not the location. This is the file's identity — see
   * scan/content-id.ts for why location could never be.
   */
  contentId: z.string(),
  /**
   * Which probe produced the technical fields below.
   *
   * Identical bytes mean identical technical FACTS, but not identical DERIVED ones:
   * when ffprobe mapping learns to read something new, a stored entry is stale even
   * though the file has not changed. Without this, `contentId` stands in for "we
   * already know everything about this file" and a rescan silently skips it forever.
   * See PROBE_VERSION in scan/probe.ts.
   */
  probeVersion: z.number().int().default(0),
  /** Everywhere this file has been observed, newest first. */
  sightings: z.array(SightingSchema).default([]),
  /** The original scene string, verbatim. Never rewritten. */
  releaseName: z.string(),

  edition: z.string().optional(),
  /** Technical provenance (Hybrid, Proper). NOT a different cut — see §5.2. */
  releaseAttributes: z.array(z.string()).default([]),
  source: z.string().optional(),
  releaseGroup: z.string().optional(),

  /**
   * Which episode this file is — shows only. Read from the name and the folders around
   * it (scan/episode.ts): it is the one structural fact only the filename can supply,
   * so §5.3 gives numbering to the filename the way it gives it edition and group.
   */
  season: z.number().int().nonnegative().optional(),
  episode: z.number().int().positive().optional(),
  /** Last episode of a multi-episode file — `S08E01E02` is episode 1, episodeEnd 2. */
  episodeEnd: z.number().int().positive().optional(),
  /** The filename's episode title. A fallback only; TMDB's name wins once enriched. */
  episodeTitle: z.string().optional(),

  container: z.string(),
  videoCodec: z.string(),
  profile: z.string().optional(),
  resolution: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  bitDepth: z.number().int().optional(),
  hdr: HdrFormatSchema,
  dvProfile: z.number().int().optional(),
  bitrateMbps: z.number(),
  sizeBytes: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  frameRate: z.number().optional(),

  audio: z.array(AudioTrackSchema).default([]),
  subtitles: z.array(SubtitleTrackSchema).default([]),
  chapters: z.array(ChapterSchema).default([]),

});

export const ExternalIdsSchema = z.object({
  imdbId: z.string().optional(),
  tmdbId: z.number().int().optional(),
});

export const MatchStateSchema = z.enum(['auto', 'confirmed', 'review', 'unmatched']);

/** TMDB's description of one season. Shows only, and only seasons the library holds. */
export const SeasonInfoSchema = z.object({
  season: z.number().int().nonnegative(),
  name: z.string(),
  overview: z.string().optional(),
  airYear: z.number().int().optional(),
  /** How many episodes TMDB lists — lets the UI say "8 of 10 episodes" honestly. */
  episodeCount: z.number().int().nonnegative().optional(),
});

/** TMDB's description of one owned episode. Keyed by season and number, not by file. */
export const EpisodeInfoSchema = z.object({
  season: z.number().int().nonnegative(),
  episode: z.number().int().positive(),
  name: z.string(),
  overview: z.string().optional(),
  airDate: z.string().optional(),
  runtimeMinutes: z.number().optional(),
  /** Local path to the downloaded still, like `artwork.poster`. */
  still: z.string().optional(),
});

export const TitleSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['movie', 'show']),

  title: z.string().min(1),
  sortTitle: z.string(),
  originalTitle: z.string().optional(),
  year: z.number().int().optional(),
  /** Earlier year for re-cuts: Caligula (2023) of a 1979 film. */
  originalYear: z.number().int().optional(),

  tagline: z.string().optional(),
  overview: z.string().default(''),
  genres: z.array(z.string()).default([]),
  runtimeMinutes: z.number().optional(),
  certification: z.string().optional(),
  contentTags: z.array(z.string()).default([]),
  cast: z.array(z.object({ name: z.string(), character: z.string().optional() })).default([]),
  directors: z.array(z.string()).default([]),
  /** Shows only: who created it. A show's director changes from episode to episode. */
  creators: z.array(z.string()).default([]),
  /**
   * Shows only: a scene country suffix (`The.Office.US`) as a TMDB `origin_country`
   * code. Kept on the title because the episode that carried it may be a bare
   * `S01E01.mkv` next time, and it is the one way to tell a remake from its original.
   */
  originCountry: z.string().optional(),
  /** Shows only: the last year it aired, for "2008–2013". Absent while still running. */
  endYear: z.number().int().optional(),
  /** Shows only. Named `…Info` so they are never confused with the files in `media`. */
  seasonInfo: z.array(SeasonInfoSchema).default([]),
  episodeInfo: z.array(EpisodeInfoSchema).default([]),
  studio: z.string().optional(),

  /** TMDB's franchise grouping. Two or more owned members become a row. */
  collection: z.object({ id: z.number().int(), name: z.string() }).optional(),

  /**
   * Which derivation produced the fields above. A title matched under an older one is
   * re-derived from the cached response — no network, no re-match. See DERIVE_VERSION.
   */
  derivedVersion: z.number().int().default(0),

  externalIds: ExternalIdsSchema.default({}),

  trailer: z
    .object({
      source: z.enum(['youtube', 'local']),
      url: z.string().optional(),
      localPath: z.string().optional(),
      startAt: z.number().optional(),
    })
    .optional(),

  artwork: z
    .object({
      poster: z.string().optional(),
      backdrop: z.string().optional(),
      logo: z.string().optional(),
    })
    .default({}),

  /** One title, several files. Editions are why — see §5.2. */
  media: z.array(MediaFileSchema).min(1),

  similarIds: z.array(z.string()).default([]),

  matchState: MatchStateSchema,
  matchConfidence: z.number().min(0).max(1).default(0),
  /** Why a title needs review, surfaced in the "Needs attention" row. */
  matchWarnings: z.array(z.string()).default([]),
  /** Candidate strings to try against TMDB, most likely first. */
  searchTitles: z.array(z.string()).default([]),

  addedAt: z.string(),
  updatedAt: z.string(),
});

export type Sighting = z.infer<typeof SightingSchema>;

/**
 * Bring a pre-content-addressing record forward.
 *
 * Old media entries carried `volumeId` and `relPath` directly. Those become the first
 * sighting; `contentId` is left blank and filled in by the next scan, which has the
 * file open anyway. Migrating on read rather than in a one-shot script means a library
 * that has not been scanned since the change still loads and still plays.
 */
export function migrateTitle(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const t = raw as Record<string, unknown>;
  const media = t.media;
  if (!Array.isArray(media)) return raw;

  return {
    ...t,
    media: media.map((m: Record<string, unknown>) => {
      if (Array.isArray(m.sightings) && typeof m.contentId === 'string') return m;
      const { volumeId, relPath, ...rest } = m;
      return {
        ...rest,
        contentId: typeof m.contentId === 'string' ? m.contentId : '',
        sightings:
          typeof volumeId === 'string' && typeof relPath === 'string'
            ? [
                {
                  volumeId,
                  relPath,
                  fingerprint: typeof m.fingerprint === 'string' ? m.fingerprint : '',
                  lastSeen: String(t.updatedAt ?? new Date().toISOString()),
                },
              ]
            : [],
      };
    }),
  };
}

export type Title = z.infer<typeof TitleSchema>;
export type MediaFile = z.infer<typeof MediaFileSchema>;
export type MatchState = z.infer<typeof MatchStateSchema>;

// --- Volumes -----------------------------------------------------------------

export const LibraryRootSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['local', 'removable', 'smb', 'nfs']),
  /** Last known mount point. Treated as a hint — volumeUUID is the real identity. */
  path: z.string(),
  /** Survives remounts under a different name. The reason this works at all. */
  volumeUUID: z.string().optional(),
  fileSystem: z.string().optional(),
  /** Relative path proving the mount is really ours and not an empty mountpoint. */
  sentinel: z.string().optional(),
  /**
   * Someone else's drive, catalogued but not owned. Kept visible so its titles can be
   * browsed and later removed wholesale, rather than silently and permanently
   * inflating the library.
   */
  borrowed: z.boolean().default(false),
  /** True when metadata cannot be written here (NTFS on macOS, optical, NAS shares). */
  readOnly: z.boolean().default(false),
  remote: z
    .object({ host: z.string(), share: z.string(), credentialRef: z.string().optional() })
    .optional(),
  addedAt: z.string(),
});

export type LibraryRoot = z.infer<typeof LibraryRootSchema>;

export const VolumeStoreSchema = z.object({
  version: z.literal(1),
  roots: z.array(LibraryRootSchema).default([]),
});

// --- User state (NEVER regenerated — see §5.4) --------------------------------

/**
 * Where you are in one episode, keyed by the file's `contentId`.
 *
 * Content-addressed for the same reason media is: renaming or moving an episode must
 * not lose its resume point.
 */
export const EpisodeProgressSchema = z.object({
  positionSec: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  watched: z.boolean().default(false),
  lastPlayedAt: z.string(),
});

export const ProgressSchema = z.object({
  mediaIndex: z.number().int().default(0),
  positionSec: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  watched: z.boolean().default(false),
  lastPlayedAt: z.string(),
  /**
   * Shows only: WHICH episode this entry is about — the last one touched. For a film the
   * title is the file; for a show, "resume" means nothing without an episode.
   */
  contentId: z.string().optional(),
});

/**
 * Which tracks you chose for a film, remembered between sessions.
 *
 * Kept OUT of `ProgressSchema` on purpose: choosing the director's commentary before
 * pressing play is a decision that exists whether or not you have watched a second of
 * it, and progress records only appear once playback starts.
 *
 * `audio` and `subtitle` are mpv track ids, and `'no'` means subtitles off — a real
 * choice, distinct from the `undefined` that means "never chosen, let the player
 * decide".
 */
export const TrackChoiceSchema = z.object({
  audio: z.number().int().positive().optional(),
  subtitle: z.union([z.number().int().positive(), z.literal('no')]).optional(),
});

export const StateFileSchema = z.object({
  version: z.literal(1),
  progress: z.record(z.string(), ProgressSchema).default({}),
  myList: z.array(z.string()).default([]),
  thumbs: z.record(z.string(), z.enum(['up', 'down'])).default({}),
  tracks: z.record(z.string(), TrackChoiceSchema).default({}),
  /** Per-episode resume points. Defaulted, so every existing state file still parses. */
  episodes: z.record(z.string(), EpisodeProgressSchema).default({}),
});

export type Progress = z.infer<typeof ProgressSchema>;
export type TrackChoice = z.infer<typeof TrackChoiceSchema>;
export type EpisodeProgress = z.infer<typeof EpisodeProgressSchema>;
export type SeasonInfo = z.infer<typeof SeasonInfoSchema>;
export type EpisodeInfo = z.infer<typeof EpisodeInfoSchema>;
export type StateFile = z.infer<typeof StateFileSchema>;
