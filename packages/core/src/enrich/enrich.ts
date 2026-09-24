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
import { decide, scoreCandidate, type MatchScore } from './match.js';
import {
  imageUrl,
  pickImage,
  TmdbClient,
  type TmdbMovie,
  type TmdbSeason,
  type TmdbShow,
} from './tmdb.js';
import { couldHaveSeasons, decideShow, scoreShowCandidate, type ShowScore } from './match.js';
import { pickByMakers, releaseYear, runtimeAgrees, seriesMakers, shortCandidates } from './shorts.js';
import { isYearSeason } from '../scan/episode.js';
import { episodeSlots, seasonsOf, slotKey } from '../library/episodes.js';
import type { EpisodeInfo, SeasonInfo } from '../schema/index.js';

/**
 * Bumped whenever `applyDetails` learns to derive something new from a response. A
 * title stamped with an older value is re-derived from the cached JSON on the next
 * pass — free, because the response is on disk, and safe, because re-deriving is not
 * re-matching (§7.4).
 */
/*
 * 2: a poster per season, for the show's shelf of season cards — and an episode an
 *    older derivation looked for and did not find is searched ONCE more, because its
 *    title may have gone out as decomposed Unicode, which TMDB cannot read.
 */
export const DERIVE_VERSION = 2;

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
  // A show described from films has no series synopsis to fetch — TMDB has none.
  if (!title.overview && !title.episodesAsFilms) return true;
  if (opts.withArtwork && !title.artwork.poster) return true;
  // A show is never finished: a new season or episode arriving on disk needs its names
  // and stills, even though the show itself matched long ago.
  if (title.type === 'show' && showHasUndescribedEpisodes(title)) return true;
  // Matched already, but derived under older rules. The response is cached, so this
  // costs nothing and cannot re-match — see DERIVE_VERSION.
  return (
    title.derivedVersion < DERIVE_VERSION &&
    (Boolean(title.externalIds.tmdbId) || title.episodesAsFilms)
  );
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

/**
 * Where a title's artwork goes: always the project's cache, never the drive.
 *
 * This used to depend on whether the film's drive was writable — `<cache>/<id>` for a
 * writable one, `<cache>/art/<id>` otherwise — a leftover of when artwork was written
 * TO writable drives. One folder now. Records already pointing at the other keep
 * working, because the stored path is absolute and browse serves from its folder.
 */
function artworkDir(titleId: string, localCacheDir: string): string {
  return join(localCacheDir, 'art', titleId);
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

  const priorPosters = new Map(title.seasonInfo.filter((s) => s.poster).map((s) => [s.season, s.poster!]));
  const seasonInfo: SeasonInfo[] = (show.seasons ?? [])
    .filter((s) => owned.has(s.season_number))
    .map((s) => ({
      season: s.season_number,
      name: s.name,
      overview: s.overview || undefined,
      airYear: yearOf(s.air_date),
      episodeCount: s.episode_count,
      // Downloaded once; a re-derive keeps it. A re-match starts from an empty list.
      poster: priorPosters.get(s.season_number),
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

/**
 * A show described episode by episode from the TMDB FILMS its episodes are
 * (`episodesAsFilms`, see shorts.ts). Pure, like `applyShowDetails`.
 *
 * Everything series-level is derived from the films, because TMDB has no series to
 * ask: the years are the span of the films you own, genres are the films' most common,
 * and the creators are the directors most of them share. There is no series synopsis,
 * and none is invented — a description TMDB does not have is not ours to write (§5.3).
 *
 * An episode that matched nothing still gets an entry, with an empty name and no
 * `tmdbId`: that records it was looked for, so a pass does not search for it every
 * time, while the list falls back to the filename's title.
 */
export function applyShortsDetails(
  title: Title,
  entries: ReadonlyArray<{ season: number; episode: number; film: TmdbMovie | null }>,
): Title {
  const prior = new Map(title.episodeInfo.map((i) => [slotKey(i.season, i.episode), i]));
  const films = entries.flatMap((e) => (e.film ? [e.film] : []));

  const episodeInfo: EpisodeInfo[] = entries.map(({ season, episode, film }) => {
    if (!film) return { season, episode, name: '' };
    const before = prior.get(slotKey(season, episode));
    return {
      season,
      episode,
      name: film.title,
      overview: film.overview || undefined,
      airDate: film.release_date || undefined,
      runtimeMinutes: film.runtime || undefined,
      // A still downloaded for THIS film survives a refresh; one for another does not.
      still: before?.tmdbId === film.id ? before.still : undefined,
      tmdbId: film.id,
    };
  });

  const yearsIn = (season?: number) =>
    entries
      .filter((e) => e.film && (season === undefined || e.season === season))
      .map((e) => releaseYear(e.film!))
      .filter((y): y is number => y !== undefined);
  const years = yearsIn();
  const first = years.length ? Math.min(...years) : title.year;
  const last = years.length ? Math.max(...years) : undefined;

  const seasonInfo: SeasonInfo[] = [...new Set(entries.map((e) => e.season))]
    .sort((a, b) => a - b)
    .map((season) => {
      const inSeason = yearsIn(season);
      return {
        season,
        name: `Season ${season}`,
        airYear: inSeason.length ? Math.min(...inSeason) : undefined,
        poster: title.seasonInfo.find((s) => s.season === season)?.poster,
      };
    });

  // The films' genres, most common first; earlier-seen first on a tie.
  const genreCount = new Map<string, number>();
  for (const f of films) for (const g of f.genres ?? []) genreCount.set(g.name, (genreCount.get(g.name) ?? 0) + 1);
  const genres = [...genreCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  const missing = entries.length - films.length;
  return {
    ...title,
    year: first,
    endYear: first !== undefined && last !== undefined && last > first ? last : undefined,
    overview: '',
    tagline: undefined,
    genres,
    cast: [],
    directors: [],
    creators: seriesMakers(films),
    // Not a network: these were made for cinemas, and "Network: MGM" would be wrong.
    studio: undefined,
    certification: undefined,
    collection: undefined,
    seasonInfo,
    episodeInfo,
    episodesAsFilms: true,
    derivedVersion: DERIVE_VERSION,
    matchState:
      title.matchState === 'confirmed' ? 'confirmed' : films.length > 0 ? 'auto' : 'unmatched',
    matchConfidence: entries.length ? Math.round((films.length / entries.length) * 100) / 100 : 0,
    matchWarnings: missing > 0 ? [`${missing} of ${entries.length} episodes not found on TMDB`] : [],
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

/**
 * Describe a year-numbered show from TMDB FILMS, episode by episode (shorts.ts).
 *
 * An episode matched before is re-derived from its film's cached details and never
 * searched for again (§7.4). One looked for and not found is left alone too, unless
 * forced. Only new episodes are searched: a title near-exact, released within its
 * season's span, the right length — and if two films still fit, the one made by the
 * people who made the rest of the series.
 */
async function enrichShorts(
  title: Title,
  client: TmdbClient,
  store: MetaStore,
  localCacheDir: string,
  opts: EnrichOptions,
): Promise<EnrichOutcome> {
  try {
    const slots = episodeSlots(title).filter((s) => isYearSeason(s.season));
    const prior = new Map(title.episodeInfo.map((i) => [slotKey(i.season, i.episode), i]));
    const picks = new Map<string, TmdbMovie | null>();
    const ambiguous = new Map<string, TmdbMovie[]>();

    await downloadAll(
      slots.map((slot) => async () => {
        const before = title.episodesAsFilms ? prior.get(slot.key) : undefined;
        // Matched: re-derive from cache. Not found: left alone — except once under a
        // newer derivation, which may search better than the one that gave up.
        const settled = before && (before.tmdbId !== undefined || title.derivedVersion >= DERIVE_VERSION);
        if (before && settled && !opts.force) {
          picks.set(slot.key, before.tmdbId ? await client.movieDetails(before.tmdbId) : null);
          return;
        }
        const name = slot.files.find((f) => f.episodeTitle)?.episodeTitle;
        if (!name) {
          picks.set(slot.key, null);
          return;
        }
        const candidates = shortCandidates(name, slot.season, await client.searchMovie(name)).slice(0, 3);
        const fileSec = slot.files[0].durationSec;
        const fits = (await Promise.all(candidates.map((c) => client.movieDetails(c.id)))).filter((f) =>
          runtimeAgrees(fileSec, f.runtime),
        );
        picks.set(slot.key, fits.length === 1 ? fits[0] : null);
        if (fits.length > 1) ambiguous.set(slot.key, fits);
      }),
    );

    // Settled only once every unambiguous episode has had its say.
    const makers = seriesMakers([...picks.values()].filter((f): f is TmdbMovie => f !== null));
    for (const [key, options] of ambiguous) picks.set(key, pickByMakers(options, makers));

    const entries = slots.map((s) => ({ season: s.season, episode: s.episode, film: picks.get(s.key) ?? null }));
    const matched = entries.filter((e) => e.film).length;
    if (matched === 0) return { titleId: title.id, status: 'not-found' };

    const firstTime = !title.episodesAsFilms;
    let updated = applyShortsDetails(title, entries);

    if (!opts.skipArtwork) {
      const dir = artworkDir(title.id, localCacheDir);
      const artwork: Title['artwork'] = firstTime || opts.force ? {} : { ...title.artwork };
      // The show's own pictures come from its earliest film: the one that began it.
      const films = entries
        .flatMap((e) => (e.film ? [e.film] : []))
        .sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''));

      if (!artwork.poster) {
        const poster = films.map((f) => pickImage(f.images?.posters, 'poster')).find(Boolean);
        if (poster && (await download(imageUrl(poster, 'w500'), join(dir, 'poster.jpg')))) {
          artwork.poster = join(dir, 'poster.jpg');
        }
      }
      if (!artwork.backdrop) {
        const backdrop = films.map((f) => pickImage(f.images?.backdrops, 'backdrop')).find(Boolean);
        if (backdrop && (await download(imageUrl(backdrop, 'w1280'), join(dir, 'backdrop.jpg')))) {
          artwork.backdrop = join(dir, 'backdrop.jpg');
        }
      }

      // Each episode's still is its film's backdrop — landscape, like a TV still.
      const byKey = new Map(entries.map((e) => [slotKey(e.season, e.episode), e.film]));
      const jobs = updated.episodeInfo
        .filter((i) => i.tmdbId && !i.still)
        .map((info) => async () => {
          const film = byKey.get(slotKey(info.season, info.episode));
          const backdrop = film ? pickImage(film.images?.backdrops, 'backdrop') : null;
          if (!backdrop) return;
          const file = `still-s${String(info.season).padStart(2, '0')}e${String(info.episode).padStart(3, '0')}.jpg`;
          if (await download(imageUrl(backdrop, 'w300'), join(dir, file))) info.still = join(dir, file);
        });
      await downloadAll(jobs);

      // Each season's card wears the poster of the film that season began with.
      const opener = new Map<number, string>();
      for (const e of [...entries].sort((a, b) => (a.film?.release_date ?? '').localeCompare(b.film?.release_date ?? ''))) {
        const poster = e.film ? pickImage(e.film.images?.posters, 'poster') : null;
        if (poster && !opener.has(e.season)) opener.set(e.season, poster);
      }
      await downloadAll(
        updated.seasonInfo
          .filter((s) => !s.poster && opener.has(s.season))
          .map((info) => async () => {
            const file = `season-s${String(info.season).padStart(2, '0')}.jpg`;
            if (await download(imageUrl(opener.get(info.season)!, 'w342'), join(dir, file))) info.poster = join(dir, file);
          }),
      );

      updated = { ...updated, artwork };
    }

    await store.save(updated);
    return {
      titleId: title.id,
      status: firstTime ? 'matched' : 'refreshed',
      matchedTo: `${matched} of ${entries.length} episodes, as TMDB films`,
      confidence: updated.matchConfidence,
      reasons: updated.matchWarnings,
    };
  } catch (err) {
    return { titleId: title.id, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

async function enrichShow(
  title: Title,
  client: TmdbClient,
  store: MetaStore,
  localCacheDir: string,
  country: string,
  opts: EnrichOptions,
): Promise<EnrichOutcome> {
  // Described from films before: stay that way. Searching TV again would only find the
  // series the year guard already ruled out. `force` re-asks TV, in case TMDB added one.
  if (title.episodesAsFilms && !opts.force) {
    if (!showHasUndescribedEpisodes(title) && title.derivedVersion >= DERIVE_VERSION) {
      return { titleId: title.id, status: 'skipped' };
    }
    return enrichShorts(title, client, store, localCacheDir, opts);
  }

  const yearSeasons = seasonsOf(episodeSlots(title)).filter(isYearSeason);
  const earliestYearSeason = yearSeasons.length ? Math.min(...yearSeasons) : undefined;

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
            if (!couldHaveSeasons(c, earliestYearSeason)) continue;
            if (!seen.has(c.id)) seen.set(c.id, scoreShowCandidate(query, c));
          }
        }
        const decision = decideShow([...seen.values()]);
        if (!decision.best) {
          return earliestYearSeason !== undefined
            ? enrichShorts(title, client, store, localCacheDir, opts)
            : { titleId: title.id, status: 'not-found' };
        }
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
    // A series with none of the year-numbered seasons on disk cannot describe them —
    // unless the user said this is the one.
    if (
      yearSeasons.length > 0 &&
      title.matchState !== 'confirmed' &&
      !(show.seasons ?? []).some((s) => yearSeasons.includes(s.season_number))
    ) {
      return enrichShorts(title, client, store, localCacheDir, opts);
    }
    const owned = seasonsOf(episodeSlots(title));
    const seasons = (
      await Promise.all(owned.map((n) => client.tvSeason(tmdbId!, n).catch(() => null)))
    ).filter((s): s is TmdbSeason => s !== null);

    // Matched to a DIFFERENT series than before: nothing described under the old one
    // may survive, or its episode stills would sit on the new show's matching numbers.
    // The same goes for a show described from films until now: those stills and names
    // belong to the films.
    const base =
      (title.externalIds.tmdbId !== undefined && title.externalIds.tmdbId !== tmdbId) || title.episodesAsFilms
        ? { ...title, episodeInfo: [], seasonInfo: [], artwork: {} }
        : title;
    let updated: Title = { ...applyShowDetails(base, show, seasons, country), episodesAsFilms: false };
    if (matchNow && title.matchState !== 'confirmed') {
      updated.matchState = verdict;
      updated.matchConfidence = confidence;
      updated.matchWarnings = verdict === 'auto' ? [] : reasons;
    }

    if (!opts.skipArtwork) {
      const dir = artworkDir(title.id, localCacheDir);
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

      // A poster per owned season, for the season cards on the show's own shelf.
      const seasonPosters = new Map(
        (show.seasons ?? []).filter((s) => s.poster_path).map((s) => [s.season_number, s.poster_path!]),
      );
      await downloadAll(
        updated.seasonInfo
          .filter((s) => !s.poster && seasonPosters.has(s.season))
          .map((info) => async () => {
            const file = `season-s${String(info.season).padStart(2, '0')}.jpg`;
            if (await download(imageUrl(seasonPosters.get(info.season)!, 'w342'), join(dir, file))) info.poster = join(dir, file);
          }),
      );

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
  store: MetaStore,
  localCacheDir: string,
  country: string,
  opts: EnrichOptions = {},
): Promise<EnrichOutcome> {
  if (title.type === 'show') {
    return enrichShow(title, client, store, localCacheDir, country, opts);
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
      const dir = artworkDir(title.id, localCacheDir);
      const poster = pickImage(movie.images?.posters, 'poster');
      const backdrop = pickImage(movie.images?.backdrops, 'backdrop');
      const logo = pickImage(movie.images?.logos, 'logo');

      const artwork: Title['artwork'] = {};
      if (poster && (await download(imageUrl(poster, 'w500'), join(dir, 'poster.jpg')))) {
        artwork.poster = join(dir, 'poster.jpg');
      }
      if (backdrop && (await download(imageUrl(backdrop, 'w1280'), join(dir, 'backdrop.jpg')))) {
        artwork.backdrop = join(dir, 'backdrop.jpg');
      }
      if (logo && (await download(imageUrl(logo, 'w500'), join(dir, 'logo.png')))) {
        artwork.logo = join(dir, 'logo.png');
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
