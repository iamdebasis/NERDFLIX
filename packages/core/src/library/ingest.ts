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
  /** Known content found at a new path on this volume. */
  relocated: number;
  /** Known content seen on this volume for the first time — a copy from elsewhere. */
  alreadyKnown: number;
  editionsAdded: number;
  skippedConfirmed: number;
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
    })),
    subtitles: p.subtitles.map((s) => ({ lang: s.lang, format: s.format, forced: s.forced })),
    chapters: p.chapters,
  };
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
    relocated: 0,
    alreadyKnown: 0,
    editionsAdded: 0,
    skippedConfirmed: 0,
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
      // Identical content means identical technical facts, so there is nothing to
      // update on the media entry — only where it now lives.
      const how = noteSighting(known.media, sighting);
      if (how === 'moved') stats.relocated += 1;
      else if (how === 'new') stats.alreadyKnown += 1;
      else stats.unchanged += 1;

      await store.save(known.title);
      continue;
    }

    const { parsed, externalIds } = scanned;
    const type = parsed.isShow ? ('show' as const) : ('movie' as const);
    const id = makeSlug(parsed.title || scanned.unit.releaseName, parsed.year);
    const found =
      (externalIds.imdbId ? byImdb.get(externalIds.imdbId) : undefined) ?? byId.get(id);

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
