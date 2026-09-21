/**
 * External-ID extraction from release sidecars. See ARCHITECTURE.md §7.4 step 2.
 *
 * Scene .nfo files nearly always carry an IMDb URL. Lifting `tt0103064` out of one
 * turns a fuzzy title+year search into an exact /find lookup with confidence 1.0,
 * which removes an entire class of mismatch for free.
 *
 * .nfo files are frequently CP437/latin1 (ASCII art headers), so never assume UTF-8.
 */

import { readFile } from 'node:fs/promises';

export type ExternalIds = {
  imdbId?: string;
  tmdbId?: number;
  /** Which sidecar it came from, for provenance in the scan report. */
  source?: string;
};

const IMDB_RE = /\b(tt\d{7,9})\b/i;
const TMDB_RE = /themoviedb\.org\/movie\/(\d+)/i;

/** Read as latin1: never throws on scene ASCII art, and ASCII IDs survive intact. */
async function readLoose(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString('latin1');
}

export async function extractExternalIds(sidecars: string[]): Promise<ExternalIds> {
  for (const path of sidecars) {
    let text: string;
    try {
      text = await readLoose(path);
    } catch {
      continue;
    }

    const imdb = text.match(IMDB_RE);
    const tmdb = text.match(TMDB_RE);

    if (imdb || tmdb) {
      return {
        imdbId: imdb ? imdb[1].toLowerCase() : undefined,
        tmdbId: tmdb ? Number(tmdb[1]) : undefined,
        source: path,
      };
    }
  }
  return {};
}
