/**
 * Enrichment: unmatched scan records become full titles.
 *
 * Resolution order mirrors ARCHITECTURE.md §7.4 — an external id from a release .nfo
 * is exact and skips scoring entirely; everything else goes through fuzzy matching and
 * is either auto-accepted or routed to review. A `confirmed` title is never touched.
 *
 * Artwork is written to the drive alongside the metadata, so a library handed to
 * another Mac arrives with its posters rather than re-downloading them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Title } from '../schema/index.js';
import type { MetaStore } from '../store/meta-store.js';
import type { VolumeState } from '../volumes/manager.js';
import { SIDECAR_DIR, isWritable, writeTitleToDrive } from '../library/sidecar.js';
import { decide, scoreCandidate, type MatchScore } from './match.js';
import { imageUrl, pickImage, TmdbClient, type TmdbMovie } from './tmdb.js';

export type EnrichOutcome = {
  titleId: string;
  status: 'matched' | 'review' | 'not-found' | 'skipped' | 'failed';
  matchedTo?: string;
  confidence?: number;
  reasons?: string[];
  alternatives?: string[];
  error?: string;
};

export type EnrichOptions = {
  /** Re-enrich titles that already have metadata. */
  force?: boolean;
  /** Skip artwork downloads — useful for a fast metadata-only pass. */
  skipArtwork?: boolean;
  onProgress?: (done: number, total: number, title: string) => void;
};

/** Where artwork goes: the drive when writable, so it travels with the films. */
async function artworkDir(
  titleId: string,
  volumeStates: VolumeState[],
  title: Title,
  localCacheDir: string,
): Promise<{ dir: string; onDrive: boolean }> {
  const volumeId = title.media[0]?.sightings[0]?.volumeId;
  const state = volumeStates.find((s) => s.root.id === volumeId);

  if (state?.resolvedPath && (await isWritable(state.resolvedPath))) {
    // Artwork always lands in the project's cache. Writing it to the drive was only
    // ever an optimisation, and one that cannot work on read-only or borrowed media.
    return { dir: join(localCacheDir, titleId), onDrive: false };
  }
  return { dir: join(localCacheDir, 'art', titleId), onDrive: false };
}

async function download(url: string, target: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/** Certification for the viewer's country, falling back to US. */
function certificationFor(movie: TmdbMovie, country: string): string | undefined {
  const results = movie.release_dates?.results ?? [];
  for (const iso of [country, 'US']) {
    const entry = results.find((r) => r.iso_3166_1 === iso);
    const cert = entry?.release_dates?.map((d) => d.certification).find((c) => c && c.length > 0);
    if (cert) return cert;
  }
  return undefined;
}

function applyDetails(title: Title, movie: TmdbMovie, country: string): Title {
  const directors = (movie.credits?.crew ?? [])
    .filter((c) => c.job === 'Director')
    .map((c) => c.name);

  const trailer = (movie.videos?.results ?? [])
    .filter((v) => v.site === 'YouTube' && v.type === 'Trailer')
    .sort((a, b) => Number(b.official ?? 0) - Number(a.official ?? 0))[0];

  return {
    ...title,
    title: movie.title || title.title,
    originalTitle: movie.original_title,
    year: movie.release_date ? Number(movie.release_date.slice(0, 4)) : title.year,
    tagline: movie.tagline || undefined,
    overview: movie.overview ?? '',
    genres: (movie.genres ?? []).map((g) => g.name),
    // Runtime stays ffprobe's: it describes the file on disk, not the canonical cut.
    runtimeMinutes: title.runtimeMinutes,
    certification: certificationFor(movie, country),
    cast: (movie.credits?.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 8)
      .map((c) => ({ name: c.name, character: c.character })),
    directors,
    studio: movie.production_companies?.[0]?.name,
    externalIds: {
      ...title.externalIds,
      tmdbId: movie.id,
      imdbId: title.externalIds.imdbId ?? movie.external_ids?.imdb_id,
    },
    trailer: trailer
      ? { source: 'youtube', url: `https://www.youtube.com/watch?v=${trailer.key}` }
      : title.trailer,
  };
}

export async function enrichTitle(
  title: Title,
  client: TmdbClient,
  volumeStates: VolumeState[],
  store: MetaStore,
  localCacheDir: string,
  country: string,
  opts: EnrichOptions = {},
): Promise<EnrichOutcome> {
  // §7.4: a human correction is never undone by a later automated pass.
  if (title.matchState === 'confirmed' && !opts.force) {
    return { titleId: title.id, status: 'skipped' };
  }
  if (!opts.force && title.matchState === 'auto' && title.overview) {
    return { titleId: title.id, status: 'skipped' };
  }

  const fileSeconds = title.media[0]?.durationSec ?? 0;

  try {
    let tmdbId: number | null = null;
    let confidence = 0;
    let reasons: string[] = [];
    let alternatives: string[] = [];
    let verdict: 'auto' | 'review' = 'review';

    if (title.externalIds.imdbId) {
      const found = await client.findByImdb(title.externalIds.imdbId);
      if (found) {
        tmdbId = found.id;
        confidence = 1;
        verdict = 'auto';
        reasons = ['exact match from .nfo IMDb id'];
      }
    }

    if (tmdbId === null) {
      const probes = title.searchTitles.length ? title.searchTitles : [title.title];
      const seen = new Map<number, MatchScore>();

      for (const probe of probes) {
        for (const year of [title.year, title.originalYear, undefined]) {
          const results = await client.searchMovie(probe, year ?? undefined);
          for (const r of results.slice(0, 6)) {
            if (seen.has(r.id)) continue;
            seen.set(r.id, scoreCandidate(title as never, r, fileSeconds));
          }
          if (seen.size >= 10) break;
        }
        if (seen.size >= 10) break;
      }

      const decision = decide([...seen.values()]);
      if (!decision.best) return { titleId: title.id, status: 'not-found' };

      tmdbId = decision.best.candidate.id;
      confidence = Math.round(decision.best.score * 100) / 100;
      reasons = decision.best.reasons;
      verdict = decision.verdict === 'auto' ? 'auto' : 'review';
      alternatives = decision.runnersUp.map(
        (r) => `${r.candidate.title} (${(r.candidate.release_date ?? '????').slice(0, 4)})`,
      );
    }

    const movie = await client.movieDetails(tmdbId);
    let updated = applyDetails(title, movie, country);
    updated.matchState = verdict === 'auto' ? 'auto' : 'review';
    updated.matchConfidence = confidence;
    updated.matchWarnings = verdict === 'auto' ? [] : reasons;

    if (!opts.skipArtwork) {
      const { dir, onDrive } = await artworkDir(title.id, volumeStates, title, localCacheDir);
      const poster = pickImage(movie.images?.posters, 'poster');
      const backdrop = pickImage(movie.images?.backdrops, 'backdrop');
      const logo = pickImage(movie.images?.logos, 'logo');

      const artwork: Title['artwork'] = {};
      if (poster && (await download(imageUrl(poster, 'w500'), join(dir, 'poster.jpg')))) {
        artwork.poster = onDrive ? `${SIDECAR_DIR}/artwork/${title.id}/poster.jpg` : join(dir, 'poster.jpg');
      }
      if (backdrop && (await download(imageUrl(backdrop, 'w1280'), join(dir, 'backdrop.jpg')))) {
        artwork.backdrop = onDrive ? `${SIDECAR_DIR}/artwork/${title.id}/backdrop.jpg` : join(dir, 'backdrop.jpg');
      }
      if (logo && (await download(imageUrl(logo, 'w500'), join(dir, 'logo.png')))) {
        artwork.logo = onDrive ? `${SIDECAR_DIR}/artwork/${title.id}/logo.png` : join(dir, 'logo.png');
      }
      updated = { ...updated, artwork };
    }

    await store.save(updated);

    return {
      titleId: title.id,
      status: verdict === 'auto' ? 'matched' : 'review',
      matchedTo: `${movie.title} (${(movie.release_date ?? '????').slice(0, 4)})`,
      confidence,
      reasons,
      alternatives,
    };
  } catch (err) {
    return {
      titleId: title.id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
