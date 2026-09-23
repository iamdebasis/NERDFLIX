/**
 * Ingest — scan results become persisted title records.
 *
 * Matching is by `contentId`, never by location. That single change is what makes
 * borrowed and read-only drives first-class:
 *
 *   - a file copied from another drive is recognised on sight, keeping its metadata
 *   - the same film on two drives is one title with two sightings, not a duplicate
 *   - renames and cross-drive moves are free, because neither changes the bytes
 *   - nothing is ever written to the drive being scanned
 *
 * Two rules still hold: a 'confirmed' title is never re-matched, and a file is only
 * re-probed when its fingerprint changed.
 */

import { relative } from 'node:path';
import type { ScanReport, ScannedTitle } from '../scan/scan.js';
import { PROBE_VERSION } from '../scan/probe.js';
import type { EpisodeRef } from '../scan/episode.js';
import { normalizeTitle } from '../scan/parse.js';
import type { LibraryRoot, MediaFile, Sighting, Title } from '../schema/index.js';
import { makeSlug, makeSortTitle, MetaStore } from '../store/meta-store.js';

export type MissingSighting = {
  titleId: string;
  title: string;
  relPath: string;
  /** No other volume holds this file, so pruning removes the media entry itself. */
  onlyCopy: boolean;
  /** That entry was the title's last, so pruning removes the title. */
  lastMedia: boolean;
};

export type IngestStats = {
  created: number;
  updated: number;
  unchanged: number;
  /** Files whose technical fields were refreshed under a newer probe. */
  reprobed: number;
  /** Known content found at a new path on this volume. */
  relocated: number;
  /** Known content seen on this volume for the first time — a copy from elsewhere. */
  alreadyKnown: number;
  editionsAdded: number;
  /** Episodes that joined a show already in the library. */
  episodesAdded: number;
  skippedConfirmed: number;
  /**
   * Files deliberately not catalogued, with the reason. Reported rather than turned
   * into titles: a season pack with no placeable episode would otherwise become a film
   * called "Show S01", and an episode with no series name has nowhere to go.
   */
  skipped: Array<{ relPath: string; reason: 'tv-without-episode' | 'unnamed-series' }>;
  missing: MissingSighting[];
  pruned: number;
};

export type IngestOptions = {
  /**
   * Remove sightings whose files are gone. Off by default: scanning must never destroy
   * metadata as a side effect, and "not found" can mean a half-finished copy or a drive
   * that mounted oddly rather than a deletion.
   */
  prune?: boolean;
};

function toMediaFile(t: ScannedTitle, root: LibraryRoot, rootPath: string): MediaFile | null {
  if (!t.probe || !t.contentId) return null;
  const p = t.probe;

  return {
    contentId: t.contentId,
    sightings: [
      {
        volumeId: root.id,
        relPath: relative(rootPath, t.unit.videoPath),
        fingerprint: t.fingerprint,
        lastSeen: new Date().toISOString(),
      },
    ],
    releaseName: t.unit.releaseName,
    edition: t.parsed.edition,
    releaseAttributes: t.parsed.releaseAttributes,
    source: t.parsed.source,
    releaseGroup: t.parsed.releaseGroup,
    container: p.container,
    videoCodec: p.videoCodec,
    profile: p.profile,
    resolution: p.resolution,
    width: p.width,
    height: p.height,
    bitDepth: p.bitDepth,
    hdr: p.hdr,
    dvProfile: p.dvProfile,
    bitrateMbps: p.bitrateMbps,
    sizeBytes: p.sizeBytes,
    durationSec: p.durationSec,
    frameRate: p.frameRate,
    audio: p.audio.map((a) => ({
      codec: a.codec,
      channels: a.channels,
      lang: a.lang,
      title: a.title,
      bitrateKbps: a.bitrateKbps,
      objectAudio: a.objectAudio,
      isDefault: a.isDefault,
    })),
    probeVersion: PROBE_VERSION,
    subtitles: p.subtitles.map((s) => ({
      lang: s.lang,
      title: s.title,
      format: s.format,
      forced: s.forced,
      isDefault: s.isDefault,
    })),
    chapters: p.chapters,
  };
}

/**
 * Copy the technical fields from a fresh probe onto an existing entry.
 *
 * Deliberately field by field rather than a spread: `sightings` describes WHERE the
 * file has been seen and is accumulated over time, so overwriting it with a single
 * fresh sighting would throw away every other place this content has been found.
 * `edition` and the release fields likewise come from the name, not the stream.
 */
function refreshTechnical(target: MediaFile, fresh: MediaFile): void {
  target.container = fresh.container;
  target.videoCodec = fresh.videoCodec;
  target.profile = fresh.profile;
  target.resolution = fresh.resolution;
  target.width = fresh.width;
  target.height = fresh.height;
  target.bitDepth = fresh.bitDepth;
  target.hdr = fresh.hdr;
  target.dvProfile = fresh.dvProfile;
  target.bitrateMbps = fresh.bitrateMbps;
  target.sizeBytes = fresh.sizeBytes;
  target.durationSec = fresh.durationSec;
  target.frameRate = fresh.frameRate;
  target.audio = fresh.audio;
  target.subtitles = fresh.subtitles;
  target.chapters = fresh.chapters;
  target.probeVersion = fresh.probeVersion;
}

/** Stamp episode numbering on a media entry. Recomputed on every scan — see below. */
function applyEpisode(media: MediaFile, ep: EpisodeRef): void {
  media.season = ep.season;
  media.episode = ep.episode;
  media.episodeEnd = ep.episodeEnd;
  media.episodeTitle = ep.episodeTitle;
}

/**
 * A show's id. The `show-` prefix is not decoration: ids are global — the renderer, the
 * trailer player and `state/` all key on them — and a show and a film can share a name.
 * Without it, episodes of the series *Chernobyl* would be filed into the film's record.
 */
export function showId(ep: Pick<EpisodeRef, 'series' | 'seriesYear' | 'country'>): string {
  const base = makeSlug(ep.series, ep.seriesYear);
  return `show-${base}${ep.country ? `-${ep.country.toLowerCase()}` : ''}`;
}

/**
 * Which existing show an episode belongs to.
 *
 * Episodes of one show are rarely named identically — one carries a year from its
 * folder, the next is a bare scene name — so an exact id match alone would split them.
 * Matching is by name, and a year or country only EXCLUDES: two shows that differ in
 * either are different shows (The Office 2001 is not The Office 2005).
 *
 * When more than one show remains, it refuses to guess. A split show is easy to spot and
 * costs nothing; a wrong merge mixes two series' episodes under one title.
 */
function findShow(shows: Title[], ep: EpisodeRef): Title | null {
  const key = normalizeTitle(ep.series);
  const candidates = shows.filter((s) => {
    const names = [s.title, ...s.searchTitles].map(normalizeTitle);
    if (!names.includes(key)) return false;
    if (ep.country && s.originCountry && ep.country !== s.originCountry) return false;
    if (ep.seriesYear && s.year && Math.abs(ep.seriesYear - s.year) > 1) return false;
    return true;
  });
  if (candidates.length <= 1) return candidates[0] ?? null;

  const exact = candidates.find((s) => s.id === showId(ep));
  return exact ?? null;
}

/** Record that this file is (still) here, without duplicating the sighting. */
function noteSighting(media: MediaFile, sighting: Sighting): 'new' | 'moved' | 'same' {
  const existing = media.sightings.find((s) => s.volumeId === sighting.volumeId);
  if (!existing) {
    media.sightings.unshift(sighting);
    return 'new';
  }
  if (existing.relPath !== sighting.relPath) {
    existing.relPath = sighting.relPath;
    existing.fingerprint = sighting.fingerprint;
    existing.lastSeen = sighting.lastSeen;
    return 'moved';
  }
  existing.fingerprint = sighting.fingerprint;
  existing.lastSeen = sighting.lastSeen;
  return 'same';
}

export async function ingest(
  report: ScanReport,
  root: LibraryRoot,
  rootPath: string,
  store: MetaStore,
  opts: IngestOptions = {},
): Promise<IngestStats> {
  const stats: IngestStats = {
    created: 0,
    updated: 0,
    unchanged: 0,
    reprobed: 0,
    relocated: 0,
    alreadyKnown: 0,
    editionsAdded: 0,
    episodesAdded: 0,
    skippedConfirmed: 0,
    skipped: [],
    missing: [],
    pruned: 0,
  };

  await store.init();
  const { titles: existing } = await store.loadAll();

  const byId = new Map(existing.map((t) => [t.id, t]));
  const byImdb = new Map(
    existing.filter((t) => t.externalIds.imdbId).map((t) => [t.externalIds.imdbId!, t]),
  );

  /** Replaces path-based lookup: everything catalogued, keyed by what it actually is. */
  const byContent = new Map<string, { title: Title; media: MediaFile }>();
  for (const t of existing) {
    for (const m of t.media) {
      if (m.contentId) byContent.set(m.contentId, { title: t, media: m });
    }
  }

  const seenHere = new Set<string>();

  for (const scanned of report.titles) {
    const media = toMediaFile(scanned, root, rootPath);
    if (!media) continue;

    const sighting = media.sightings[0];
    seenHere.add(sighting.relPath);

    const known = byContent.get(media.contentId);
    if (known) {
      // Identical content means identical technical facts, so normally there is
      // nothing to update on the media entry — only where it now lives.
      const how = noteSighting(known.media, sighting);
      if (how === 'moved') stats.relocated += 1;
      else if (how === 'new') stats.alreadyKnown += 1;
      else stats.unchanged += 1;

      // Numbering comes from the name, and the name — or the parser — may have changed
      // since. Identical bytes are no reason to keep a stale S/E.
      if (known.title.type === 'show' && scanned.parsed.episode) {
        applyEpisode(known.media, scanned.parsed.episode);
      }

      /**
       * Unless WE have changed.
       *
       * The bytes being identical does not make our reading of them current: when the
       * probe learns to read a new field, every stored entry is stale while its
       * `contentId` still matches — so the rescan that was meant to pick the field up
       * skips the file entirely and the backfill silently never happens.
       *
       * Refreshing costs nothing here: ffprobe has already run on this file, because
       * the contentId needs its duration.
       */
      if (known.media.probeVersion < PROBE_VERSION) {
        refreshTechnical(known.media, media);
        stats.reprobed += 1;
      }

      await store.save(known.title);
      continue;
    }

    const { parsed, externalIds } = scanned;
    const relPath = media.sightings[0].relPath;

    if (parsed.warnings.includes('tv-without-episode')) {
      stats.skipped.push({ relPath, reason: 'tv-without-episode' });
      continue;
    }

    // --- an episode: file it under its show -------------------------------------
    if (parsed.episode) {
      const ep = parsed.episode;
      if (!ep.series) {
        stats.skipped.push({ relPath, reason: 'unnamed-series' });
        continue;
      }
      applyEpisode(media, ep);

      const shows = [...byId.values()].filter((t) => t.type === 'show');
      const show = findShow(shows, ep);
      if (show) {
        show.media.push(media);
        byContent.set(media.contentId, { title: show, media });
        stats.episodesAdded += 1;
        await store.save(show);
        continue;
      }

      const now = new Date().toISOString();
      const created: Title = {
        id: showId(ep),
        type: 'show',
        title: ep.series,
        sortTitle: makeSortTitle(ep.series),
        year: ep.seriesYear,
        originCountry: ep.country,
        overview: '',
        genres: [],
        contentTags: [],
        cast: [],
        directors: [],
        creators: [],
        seasonInfo: [],
        episodeInfo: [],
        // Deliberately empty. An episode's .nfo carries the EPISODE's IMDb id, and
        // matching the whole series on it would attach someone else's show.
        externalIds: {},
        artwork: {},
        media: [media],
        similarIds: [],
        matchState: 'unmatched',
        derivedVersion: 0,
        matchConfidence: 0,
        matchWarnings: [],
        searchTitles: [ep.series],
        runtimeMinutes: Math.round(media.durationSec / 60),
        addedAt: now,
        updatedAt: now,
      };
      await store.save(created);
      byId.set(created.id, created);
      byContent.set(media.contentId, { title: created, media });
      stats.created += 1;
      continue;
    }

    // --- a film --------------------------------------------------------------
    const type = 'movie' as const;
    const id = makeSlug(parsed.title || scanned.unit.releaseName, parsed.year);
    const byIdFilm = byId.get(id);
    const found =
      (externalIds.imdbId ? byImdb.get(externalIds.imdbId) : undefined) ??
      (byIdFilm?.type === 'movie' ? byIdFilm : undefined);

    if (found) {
      found.media.push(media);
      byContent.set(media.contentId, { title: found, media });
      stats.editionsAdded += 1;

      if (found.matchState === 'confirmed') stats.skippedConfirmed += 1;
      else if (externalIds.imdbId && !found.externalIds.imdbId) {
        found.externalIds.imdbId = externalIds.imdbId;
        found.matchState = 'auto';
        found.matchConfidence = 1;
      }
      await store.save(found);
      continue;
    }

    const now = new Date().toISOString();
    const title: Title = {
      id,
      type,
      title: parsed.title || scanned.unit.releaseName,
      sortTitle: makeSortTitle(parsed.title || scanned.unit.releaseName),
      year: parsed.year,
      originalYear: parsed.originalYear,
      overview: '',
      genres: [],
      contentTags: [],
      cast: [],
      directors: [],
      creators: [],
      seasonInfo: [],
      episodeInfo: [],
      externalIds: { imdbId: externalIds.imdbId, tmdbId: externalIds.tmdbId },
      artwork: {},
      media: [media],
      similarIds: [],
      matchState: externalIds.imdbId || externalIds.tmdbId ? 'auto' : 'unmatched',
      // Nothing derived from TMDB yet, so the first enrichment pass owns it.
      derivedVersion: 0,
      matchConfidence: externalIds.imdbId || externalIds.tmdbId ? 1 : 0,
      matchWarnings: parsed.warnings,
      searchTitles: parsed.searchTitles,
      runtimeMinutes: Math.round(media.durationSec / 60),
      addedAt: now,
      updatedAt: now,
    };

    await store.save(title);
    byId.set(id, title);
    byContent.set(media.contentId, { title, media });
    if (title.externalIds.imdbId) byImdb.set(title.externalIds.imdbId, title);
    stats.created += 1;
  }

  // --- reconcile: sightings on THIS volume whose files are gone ---------------
  const { titles: after } = await store.loadAll();

  for (const title of after) {
    let changed = false;

    for (const media of [...title.media]) {
      const here = media.sightings.find((s) => s.volumeId === root.id);
      if (!here || seenHere.has(here.relPath)) continue;

      const onlyCopy = media.sightings.length === 1;
      stats.missing.push({
        titleId: title.id,
        title: title.title,
        relPath: here.relPath,
        onlyCopy,
        lastMedia: onlyCopy && title.media.length === 1,
      });

      if (!opts.prune) continue;

      // Drop only this location: the file may still exist on another drive, and the
      // media entry — with its metadata — must survive if so.
      media.sightings = media.sightings.filter((s) => s !== here);
      if (media.sightings.length === 0) title.media = title.media.filter((m) => m !== media);
      stats.pruned += 1;
      changed = true;
    }

    if (!changed) continue;
    if (title.media.length === 0) await store.delete(title.id, title.type);
    else await store.save(title);
  }

  return stats;
}
