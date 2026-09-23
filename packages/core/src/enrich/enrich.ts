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
import {
  imageUrl,
  pickImage,
  TmdbClient,
  type TmdbMovie,
  type TmdbSeason,
  type TmdbShow,
} from './tmdb.js';
import { decideShow, scoreShowCandidate, type ShowScore } from './match.js';
import { episodeSlots, seasonsOf, slotKey } from '../library/episodes.js';
import type { EpisodeInfo, SeasonInfo } from '../schema/index.js';

/**
 * Bumped whenever `applyDetails` learns to derive something new from a response. A
 * title stamped with an older value is re-derived from the cached JSON on the next
 * pass — free, because the response is on disk, and safe, because re-deriving is not
 * re-matching (§7.4).
 */
export const DERIVE_VERSION = 1;

export type EnrichOutcome = {
  titleId: string;
  /**
   * `refreshed` — a show already matched, brought up to date with seasons it did not
   * yet describe. No search: a matched show is never re-matched.
   */
  status: 'matched' | 'review' | 'not-found' | 'skipped' | 'failed' | 'rederived' | 'refreshed';
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

/**
 * Whether a pass has anything to do for this title.
 *
 * Both callers pre-filter so they can show an honest "N of M" before starting, and the
 * two filters had quietly drifted apart. The rule belongs in one place, next to the
 * gate inside `enrichTitle` that it has to agree with.
 */
export function needsEnrichment(
  title: Title,
  opts: { force?: boolean; withArtwork?: boolean } = {},
): boolean {
  if (opts.force) return true;
  if (title.matchState === 'unmatched' || title.matchState === 'review') return true;
  if (!title.overview) return true;
  if (opts.withArtwork && !title.artwork.poster) return true;
  // A show is never finished: a new season or episode arriving on disk needs its names
  // and stills, even though the show itself matched long ago.
  if (title.type === 'show' && showHasUndescribedEpisodes(title)) return true;
  // Matched already, but derived under older rules. The response is cached, so this
  // costs nothing and cannot re-match — see DERIVE_VERSION.
  return title.derivedVersion < DERIVE_VERSION && Boolean(title.externalIds.tmdbId);
}

/** Owned episodes TMDB has not described yet — a new season, usually. */
function showHasUndescribedEpisodes(title: Title): boolean {
  const described = new Set(title.episodeInfo.map((i) => slotKey(i.season, i.episode)));
  const seasonsDescribed = new Set(title.seasonInfo.map((s) => s.season));
  return title.media.some(
    (m) =>
      m.season !== undefined &&
      m.episode !== undefined &&
      (!seasonsDescribed.has(m.season) || !described.has(slotKey(m.season, m.episode))),
  );
}

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
    collection: movie.belongs_to_collection
      ? { id: movie.belongs_to_collection.id, name: movie.belongs_to_collection.name }
      : undefined,
    derivedVersion: DERIVE_VERSION,
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

/**
 * Re-apply `applyDetails` to an already-matched title from its cached response.
 *
 * Deliberately narrow: no search, no artwork, and `matchState` is left exactly as it
 * was. `applyDetails` touches none of those, so spreading its result preserves a
 * `confirmed` verdict and the posters already on disk.
 */
async function rederiveTitle(
  title: Title,
  client: TmdbClient,
  store: MetaStore,
  country: string,
): Promise<EnrichOutcome> {
  try {
    const movie = await client.movieDetails(title.externalIds.tmdbId as number);
    const updated = applyDetails(title, movie, country);
    await store.save(updated);
    return { titleId: title.id, status: 'rederived', matchedTo: movie.title };
  } catch (err) {
    return {
      titleId: title.id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- TV ------------------------------------------------------------------------

/**
 * TMDB's TV genres are compound ("Sci-Fi & Fantasy") where its film genres are single
 * ("Science Fiction", "Fantasy"). Mapped onto the film names, so a show sits in the
 * same Science Fiction row and under the same filter pill as the films beside it,
 * rather than in a parallel "Sci-Fi & Fantasy" row of its own.
 */
const TV_GENRES: Record<string, string[]> = {
  'Action & Adventure': ['Action', 'Adventure'],
  'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War'],
  Kids: ['Family'],
};

export function showGenres(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((n) => TV_GENRES[n] ?? [n]))];
}

function yearOf(date?: string | null): number | undefined {
  const y = Number((date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1880 ? y : undefined;
}

function showCertification(show: TmdbShow, country: string): string | undefined {
  const results = show.content_ratings?.results ?? [];
  for (const iso of [country, 'US']) {
    const rating = results.find((r) => r.iso_3166_1 === iso)?.rating;
    if (rating) return rating;
  }
  return undefined;
}

/**
 * Apply a series response and the owned seasons' responses.
 *
 * Only OWNED seasons and episodes are recorded: the list shows what is on your drives,
 * and describing 20 seasons you do not have would pad every show with dead rows. The
 * artwork and matchState fields are left for the caller, as with films.
 */
export function applyShowDetails(
  title: Title,
  show: TmdbShow,
  seasons: readonly TmdbSeason[],
  country: string,
): Title {
  const slots = episodeSlots(title);
  const owned = new Set(seasonsOf(slots));
  const existingStills = new Map(
    title.episodeInfo.filter((i) => i.still).map((i) => [slotKey(i.season, i.episode), i.still!]),
  );

  const seasonInfo: SeasonInfo[] = (show.seasons ?? [])
    .filter((s) => owned.has(s.season_number))
    .map((s) => ({
      season: s.season_number,
      name: s.name,
      overview: s.overview || undefined,
      airYear: yearOf(s.air_date),
      episodeCount: s.episode_count,
    }));

  const ownedKeys = new Set(slots.map((s) => s.key));
  const episodeInfo: EpisodeInfo[] = seasons
    .flatMap((s) => s.episodes ?? [])
    .filter((e) => ownedKeys.has(slotKey(e.season_number, e.episode_number)))
    .map((e) => ({
      season: e.season_number,
      episode: e.episode_number,
      name: e.name,
      overview: e.overview || undefined,
      airDate: e.air_date || undefined,
      runtimeMinutes: e.runtime ?? undefined,
      still: existingStills.get(slotKey(e.season_number, e.episode_number)),
    }));

  const cast =
    show.aggregate_credits?.cast?.length
      ? [...show.aggregate_credits.cast]
          .sort((a, b) => a.order - b.order)
          .slice(0, 8)
          .map((c) => ({ name: c.name, character: c.roles?.[0]?.character || undefined }))
      : (show.credits?.cast ?? [])
          .sort((a, b) => a.order - b.order)
          .slice(0, 8)
          .map((c) => ({ name: c.name, character: c.character }));

  const trailer = (show.videos?.results ?? [])
    .filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
    .sort(
      (a, b) =>
        Number(b.type === 'Trailer') - Number(a.type === 'Trailer') ||
        Number(b.official ?? 0) - Number(a.official ?? 0),
    )[0];

  const ended = show.status === 'Ended' || show.status === 'Canceled';

  return {
    ...title,
    title: show.name || title.title,
    originalTitle: show.original_name,
    year: yearOf(show.first_air_date) ?? title.year,
    endYear: ended ? yearOf(show.last_air_date) : undefined,
    tagline: show.tagline || undefined,
    overview: show.overview ?? '',
    genres: showGenres((show.genres ?? []).map((g) => g.name)),
    // Runtime stays ffprobe's, as for films: it describes the files on disk.
    runtimeMinutes: title.runtimeMinutes,
    certification: showCertification(show, country),
    cast,
    directors: [],
    creators: (show.created_by ?? []).map((c) => c.name),
    // The network is what people know a series by — "an HBO show".
    studio: show.networks?.[0]?.name,
    originCountry: title.originCountry ?? show.origin_country?.[0],
    seasonInfo,
    episodeInfo,
    collection: undefined,
    derivedVersion: DERIVE_VERSION,
    externalIds: {
      ...title.externalIds,
      tmdbId: show.id,
      imdbId: show.external_ids?.imdb_id ?? title.externalIds.imdbId,
    },
    trailer: trailer
      ? { source: 'youtube', url: `https://www.youtube.com/watch?v=${trailer.key}` }
      : title.trailer,
  };
}

/** Run a few downloads at a time: a season can mean dozens of stills. */
async function downloadAll(jobs: Array<() => Promise<void>>, limit = 4): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]();
    }),
  );
}

async function enrichShow(
  title: Title,
  client: TmdbClient,
  volumeStates: VolumeState[],
  store: MetaStore,
  localCacheDir: string,
  country: string,
  opts: EnrichOptions,
): Promise<EnrichOutcome> {
  const settled =
    title.matchState === 'confirmed' || (title.matchState === 'auto' && Boolean(title.overview));

  if (settled && !opts.force && !showHasUndescribedEpisodes(title) &&
      title.derivedVersion >= DERIVE_VERSION) {
    return { titleId: title.id, status: 'skipped' };
  }

  try {
    let tmdbId = title.externalIds.tmdbId ?? null;
    let verdict: 'auto' | 'review' = title.matchState === 'review' ? 'review' : 'auto';
    let confidence = title.matchConfidence;
    let reasons: string[] = title.matchWarnings;
    let alternatives: string[] = [];
    const matchNow = !settled || opts.force || tmdbId === null;

    if (matchNow) {
      // §7.4 again: a human correction is final, even under --force.
      if (title.matchState === 'confirmed' && tmdbId !== null) {
        /* keep the confirmed id */
      } else {
        const query = {
          series: title.searchTitles[0] ?? title.title,
          year: title.year,
          country: title.originCountry,
          searchTitles: title.searchTitles,
        };
        const seen = new Map<number, ShowScore>();
        for (const year of title.year ? [title.year, undefined] : [undefined]) {
          for (const c of (await client.searchTv(query.series, year)).slice(0, 8)) {
            if (!seen.has(c.id)) seen.set(c.id, scoreShowCandidate(query, c));
          }
        }
        const decision = decideShow([...seen.values()]);
        if (!decision.best) return { titleId: title.id, status: 'not-found' };
        tmdbId = decision.best.candidate.id;
        verdict = decision.verdict === 'auto' ? 'auto' : 'review';
        confidence = Math.round(decision.best.score * 100) / 100;
        reasons = decision.best.reasons;
        alternatives = decision.runnersUp.map(
          (r) => `${r.candidate.name} (${(r.candidate.first_air_date ?? '????').slice(0, 4)})`,
        );
      }
    }

    const show = await client.tvDetails(tmdbId!);
    const owned = seasonsOf(episodeSlots(title));
    const seasons = (
      await Promise.all(owned.map((n) => client.tvSeason(tmdbId!, n).catch(() => null)))
    ).filter((s): s is TmdbSeason => s !== null);

    // Matched to a DIFFERENT series than before: nothing described under the old one
    // may survive, or its episode stills would sit on the new show's matching numbers.
    const base =
      title.externalIds.tmdbId !== undefined && title.externalIds.tmdbId !== tmdbId
        ? { ...title, episodeInfo: [], seasonInfo: [], artwork: {} }
        : title;
    let updated = applyShowDetails(base, show, seasons, country);
    if (matchNow && title.matchState !== 'confirmed') {
      updated.matchState = verdict;
      updated.matchConfidence = confidence;
      updated.matchWarnings = verdict === 'auto' ? [] : reasons;
    }

    if (!opts.skipArtwork) {
      const { dir } = await artworkDir(title.id, volumeStates, title, localCacheDir);
      const artwork: Title['artwork'] = matchNow ? {} : { ...title.artwork };

      if (!artwork.poster) {
        const poster = pickImage(show.images?.posters, 'poster');
        if (poster && (await download(imageUrl(poster, 'w500'), join(dir, 'poster.jpg')))) {
          artwork.poster = join(dir, 'poster.jpg');
        }
      }
      if (!artwork.backdrop) {
        const backdrop = pickImage(show.images?.backdrops, 'backdrop');
        if (backdrop && (await download(imageUrl(backdrop, 'w1280'), join(dir, 'backdrop.jpg')))) {
          artwork.backdrop = join(dir, 'backdrop.jpg');
        }
      }
      if (!artwork.logo) {
        const logo = pickImage(show.images?.logos, 'logo');
        if (logo && (await download(imageUrl(logo, 'w500'), join(dir, 'logo.png')))) {
          artwork.logo = join(dir, 'logo.png');
        }
      }

      /*
       * Episode stills, only for owned episodes and only those still missing one. They
       * sit beside the poster with flat names, because `media://` serves one folder
       * per title and refuses any path with a slash in it.
       */
      const stillPaths = new Map(
        seasons
          .flatMap((s) => s.episodes ?? [])
          .filter((e) => e.still_path)
          .map((e) => [slotKey(e.season_number, e.episode_number), e.still_path!]),
      );
      const jobs = updated.episodeInfo
        .filter((i) => !i.still && stillPaths.has(slotKey(i.season, i.episode)))
        .map((info) => async () => {
          const file = `still-s${String(info.season).padStart(2, '0')}e${String(info.episode).padStart(3, '0')}.jpg`;
          if (await download(imageUrl(stillPaths.get(slotKey(info.season, info.episode))!, 'w300'), join(dir, file))) {
            info.still = join(dir, file);
          }
        });
      await downloadAll(jobs);

      updated = { ...updated, artwork };
    }

    await store.save(updated);
    return {
      titleId: title.id,
      status: matchNow ? (updated.matchState === 'auto' ? 'matched' : 'review') : 'refreshed',
      matchedTo: `${show.name} (${(show.first_air_date ?? '????').slice(0, 4)})`,
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

export async function enrichTitle(
  title: Title,
  client: TmdbClient,
  volumeStates: VolumeState[],
  store: MetaStore,
  localCacheDir: string,
  country: string,
  opts: EnrichOptions = {},
): Promise<EnrichOutcome> {
  if (title.type === 'show') {
    return enrichShow(title, client, volumeStates, store, localCacheDir, country, opts);
  }

  // §7.4: a human correction is never undone by a later automated pass. `auto` with an
  // overview is likewise already answered — neither needs matching again.
  const settled =
    title.matchState === 'confirmed' || (title.matchState === 'auto' && Boolean(title.overview));

  if (settled && !opts.force) {
    // Settled, but possibly derived under older rules. Re-deriving reads the cached
    // response — no search, so the title cannot silently match differently later.
    if (title.derivedVersion < DERIVE_VERSION && title.externalIds.tmdbId) {
      return rederiveTitle(title, client, store, country);
    }
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
