/**
 * TMDB client.
 *
 * Enrichment is a batch job that runs once per title, not a runtime dependency — the
 * app never touches the network. So this optimises for completeness over frugality:
 * one `append_to_response` request pulls credits, videos, images, release dates,
 * recommendations and external ids together instead of six round trips.
 *
 * Raw responses are cached verbatim. That is deliberate: when the schema changes in
 * three months, every record can be re-derived from local cache with no network and,
 * more importantly, no re-matching — so a title that matched correctly once can never
 * silently match differently later.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TmdbCandidate } from './match.js';

const API = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

export type TmdbImage = {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  width: number;
  height: number;
};

export type TmdbMovie = {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  runtime?: number;
  tagline?: string;
  overview?: string;
  genres?: Array<{ id: number; name: string }>;
  belongs_to_collection?: { id: number; name: string } | null;
  production_companies?: Array<{ name: string }>;
  credits?: {
    cast?: Array<{ name: string; character?: string; order: number }>;
    crew?: Array<{ name: string; job: string }>;
  };
  videos?: { results?: Array<{ key: string; site: string; type: string; official?: boolean; published_at?: string }> };
  images?: { posters?: TmdbImage[]; backdrops?: TmdbImage[]; logos?: TmdbImage[] };
  release_dates?: {
    results?: Array<{
      iso_3166_1: string;
      release_dates?: Array<{ certification?: string; type?: number }>;
    }>;
  };
  recommendations?: { results?: TmdbCandidate[] };
  external_ids?: { imdb_id?: string };
};

/** A `/search/tv` result. */
export type TmdbShowCandidate = {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  origin_country?: string[];
  popularity?: number;
  vote_count?: number;
};

type TmdbVideos = {
  results?: Array<{ key: string; site: string; type: string; official?: boolean; published_at?: string }>;
};

export type TmdbShow = {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  last_air_date?: string;
  /** 'Returning Series' | 'Ended' | 'Canceled' | 'In Production' … */
  status?: string;
  tagline?: string;
  overview?: string;
  genres?: Array<{ id: number; name: string }>;
  origin_country?: string[];
  created_by?: Array<{ name: string }>;
  networks?: Array<{ name: string }>;
  seasons?: Array<{
    season_number: number;
    name: string;
    overview?: string;
    air_date?: string | null;
    episode_count?: number;
    poster_path?: string | null;
  }>;
  /** Series-wide cast. `credits` alone is only the latest season's. */
  aggregate_credits?: {
    cast?: Array<{ name: string; order: number; roles?: Array<{ character?: string }> }>;
  };
  credits?: { cast?: Array<{ name: string; character?: string; order: number }> };
  videos?: TmdbVideos;
  images?: { posters?: TmdbImage[]; backdrops?: TmdbImage[]; logos?: TmdbImage[] };
  content_ratings?: { results?: Array<{ iso_3166_1: string; rating?: string }> };
  external_ids?: { imdb_id?: string };
};

export type TmdbSeason = {
  season_number: number;
  name: string;
  overview?: string;
  air_date?: string | null;
  episodes?: Array<{
    season_number: number;
    episode_number: number;
    name: string;
    overview?: string;
    air_date?: string | null;
    runtime?: number | null;
    still_path?: string | null;
  }>;
};

export class TmdbError extends Error {}

/**
 * Every search goes out COMPOSED. TMDB returns nothing for decomposed Unicode — "Touché"
 * as "e" plus a combining accent, as names read off a macOS disk often are — and the
 * parser composing new names does not help titles already stored. One place, so no
 * caller can forget.
 */
export function searchText(query: string): string {
  return query.normalize('NFC');
}

export class TmdbClient {
  constructor(
    private readonly token: string,
    private readonly cacheDir: string,
  ) {
    if (!token) throw new TmdbError('TMDB_READ_TOKEN is not set — add it to .env');
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    // Limits are ~40–50 req/s; a few hundred titles never approaches that. Retry on
    // 429 anyway so a shared IP or a burst cannot abort a long enrichment run.
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      });

      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 1) * 1000 || 1000;
        await new Promise((r) => setTimeout(r, wait * (attempt + 1)));
        continue;
      }
      if (res.status === 401) {
        throw new TmdbError('TMDB rejected the token. Check TMDB_READ_TOKEN in .env');
      }
      if (!res.ok) throw new TmdbError(`TMDB ${res.status} for ${path}`);
      return (await res.json()) as T;
    }
    throw new TmdbError(`TMDB rate limited after retries: ${path}`);
  }

  async searchMovie(query: string, year?: number): Promise<TmdbCandidate[]> {
    const params: Record<string, string> = { query: searchText(query), include_adult: 'false' };
    if (year) params.primary_release_year = String(year);
    const data = await this.request<{ results?: TmdbCandidate[] }>('/search/movie', params);
    return data.results ?? [];
  }

  /** Exact lookup from an IMDb id lifted out of a release .nfo — confidence 1.0. */
  async findByImdb(imdbId: string): Promise<TmdbCandidate | null> {
    const data = await this.request<{ movie_results?: TmdbCandidate[] }>(
      `/find/${imdbId}`,
      { external_source: 'imdb_id' },
    );
    return data.movie_results?.[0] ?? null;
  }

  async movieDetails(id: number): Promise<TmdbMovie> {
    const cached = await this.readCache(id);
    if (cached) return cached;

    const data = await this.request<TmdbMovie>(`/movie/${id}`, {
      append_to_response: 'credits,videos,images,release_dates,recommendations,external_ids',
      include_image_language: 'en,null',
    });
    await this.writeCache(id, data);
    return data;
  }

  // --- TV -----------------------------------------------------------------------

  async searchTv(query: string, year?: number): Promise<TmdbShowCandidate[]> {
    const params: Record<string, string> = { query: searchText(query), include_adult: 'false' };
    if (year) params.first_air_date_year = String(year);
    const data = await this.request<{ results?: TmdbShowCandidate[] }>('/search/tv', params);
    return data.results ?? [];
  }

  /**
   * Everything about a series in one request, cached verbatim like films.
   *
   * The cache lives under `tmdb/tv/`, NOT beside the film responses. TMDB's film and TV
   * ids are separate number spaces — tv/1396 is Breaking Bad and movie/1396 is not —
   * so one shared folder would serve a film's response as a show's, or the reverse.
   */
  async tvDetails(id: number): Promise<TmdbShow> {
    const rel = join('tv', `${id}.json`);
    const cached = await this.readJson<TmdbShow>(rel);
    if (cached) return cached;
    const data = await this.request<TmdbShow>(`/tv/${id}`, {
      append_to_response: 'aggregate_credits,credits,videos,images,content_ratings,external_ids',
      include_image_language: 'en,null',
    });
    await this.writeJson(rel, data);
    return data;
  }

  /** One season's episodes. Only ever asked for seasons the library holds. */
  async tvSeason(id: number, season: number): Promise<TmdbSeason> {
    const rel = join('tv', `${id}-s${season}.json`);
    const cached = await this.readJson<TmdbSeason>(rel);
    if (cached) return cached;
    const data = await this.request<TmdbSeason>(`/tv/${id}/season/${season}`);
    await this.writeJson(rel, data);
    return data;
  }

  private async readJson<T>(rel: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.cacheDir, 'tmdb', rel), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(rel: string, data: unknown): Promise<void> {
    try {
      const p = join(this.cacheDir, 'tmdb', rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(data, null, 2));
    } catch {
      // Cache is an optimisation, never a requirement.
    }
  }

  private cachePath(id: number): string {
    return join(this.cacheDir, 'tmdb', `${id}.json`);
  }

  private async readCache(id: number): Promise<TmdbMovie | null> {
    try {
      return JSON.parse(await readFile(this.cachePath(id), 'utf8')) as TmdbMovie;
    } catch {
      return null;
    }
  }

  private async writeCache(id: number, data: TmdbMovie): Promise<void> {
    try {
      const p = this.cachePath(id);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(data, null, 2));
    } catch {
      // Cache is an optimisation, never a requirement.
    }
  }
}

/**
 * Pick the best image of a kind.
 *
 * Backdrops prefer the textless version (`iso_639_1 === null`) because our own title
 * logo sits on top of it — a backdrop with burned-in titles would collide.
 */
export function pickImage(
  images: TmdbImage[] | undefined,
  kind: 'poster' | 'backdrop' | 'logo',
): string | null {
  if (!images?.length) return null;

  const scored = images.map((img) => {
    let bonus = 0;
    if (kind === 'backdrop') bonus = img.iso_639_1 === null ? 2 : 0;
    else bonus = img.iso_639_1 === 'en' ? 2 : img.iso_639_1 === null ? 1 : 0;
    return { img, rank: bonus * 10 + img.vote_average };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored[0].img.file_path;
}

export function imageUrl(filePath: string, size: string): string {
  return `${IMAGE_BASE}/${size}${filePath}`;
}
