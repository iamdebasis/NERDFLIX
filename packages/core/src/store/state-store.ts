/**
 * StateStore — watch positions, My List, thumbs.
 *
 * Kept in `state/`, never in `db/`. This separation is the whole point: `db/` can be
 * deleted and rebuilt from a rescan, and the agent rewrites records in it routinely.
 * If watch history lived there, a metadata regeneration would quietly erase it.
 * See ARCHITECTURE.md §5.4.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  EpisodeProgressSchema,
  ProgressSchema,
  StateFileSchema,
  TrackChoiceSchema,
  type EpisodeProgress,
  type Progress,
  type StateFile,
  type TrackChoice,
} from '../schema/index.js';

const EMPTY: StateFile = { version: 1, progress: {}, myList: [], thumbs: {}, tracks: {}, episodes: {} };

/** A finite, non-negative number of seconds — the only thing a position may be. */
function isPosition(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Rebuild a state file entry by entry, keeping everything that validates on its own.
 * Exported for tests — see `state-safety.test.ts`.
 */
export function salvageState(raw: unknown): StateFile {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: StateFile = structuredClone(EMPTY);

  const keep = <T>(
    section: unknown,
    schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
    into: Record<string, T>,
  ) => {
    if (!section || typeof section !== 'object') return;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      const r = schema.safeParse(value);
      if (r.success) into[key] = r.data;
    }
  };

  keep(src.progress, ProgressSchema, out.progress);
  keep(src.episodes, EpisodeProgressSchema, out.episodes);
  keep(src.tracks, TrackChoiceSchema, out.tracks);
  keep(src.thumbs, z.enum(['up', 'down']), out.thumbs);
  if (Array.isArray(src.myList)) out.myList = src.myList.filter((id): id is string => typeof id === 'string');
  return out;
}

export class StateStore {
  private cache?: StateFile;
  /**
   * The first load, shared by everyone who asks while it is in flight. Without it two
   * callers at startup each parsed the file into a SEPARATE object, the second replaced
   * the first as the cache, and anything written through the first was lost.
   */
  private loading?: Promise<StateFile>;
  /** Serialises writes so two rapid progress saves cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  /**
   * Read state — and never trade the whole file for one bad field.
   *
   * This used to start clean on ANY validation failure, and the next write then saved
   * that clean slate over the file. One entry with a missing position — which a player
   * reporting an unavailable time-pos produced — silently erased every resume point,
   * My List and every track choice. `state/` is the one directory nothing regenerates.
   *
   * Now: a missing file is a first run. A file that fails validation is copied aside
   * untouched, then SALVAGED — every entry that validates on its own is kept, and only
   * the broken ones are dropped. Unparseable JSON is copied aside before starting clean,
   * so even that is recoverable by hand.
   */
  async load(): Promise<StateFile> {
    if (this.cache) return this.cache;
    this.loading ??= this.readState().then((state) => {
      this.cache = state;
      return state;
    });
    return this.loading;
  }

  private async readState(): Promise<StateFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return structuredClone(EMPTY); // no file yet: a first run
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await this.preserve(text, 'unparseable');
      return this.persistRepaired(structuredClone(EMPTY));
    }

    const strict = StateFileSchema.safeParse(raw);
    if (strict.success) return strict.data;

    await this.preserve(text, 'invalid');
    return this.persistRepaired(salvageState(raw));
  }

  /**
   * Write a repaired state straight back, so the file is valid again. Otherwise every
   * launch until the next ordinary write re-salvaged and left another backup copy.
   */
  private async persistRepaired(state: StateFile): Promise<StateFile> {
    this.cache = state;
    await this.queueWrite();
    return state;
  }


  /** Keep a byte-for-byte copy of a state file we could not use as-is. */
  private async preserve(text: string, why: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const copy = `${this.path}.${why}-${stamp}`;
    try {
      await writeFile(copy, text, 'utf8');
      console.warn(`state: ${this.path} was ${why}; original kept at ${copy}`);
    } catch {
      /* the copy is a courtesy; failing it must not block playback */
    }
  }

  private async flush(): Promise<void> {
    const data = this.cache ?? EMPTY;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tmp, this.path);
  }

  private queueWrite(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.flush()).catch(() => {});
    return this.writeChain;
  }

  async getProgress(titleId: string): Promise<Progress | null> {
    const s = await this.load();
    return s.progress[titleId] ?? null;
  }

  /**
   * Record a resume point.
   *
   * Treats the last 3% as finished, and anything under 2 minutes as not started —
   * otherwise a title you sampled for ten seconds shows up in "Continue Watching"
   * forever, and one you finished offers to resume during the credits.
   */
  async setProgress(
    titleId: string,
    positionSec: number,
    durationSec: number,
    mediaIndex = 0,
  ): Promise<void> {
    // The last line of defence: nothing that is not a real position enters state/.
    if (!isPosition(positionSec) || !isPosition(durationSec)) return;
    const s = await this.load();
    const nearEnd = durationSec > 0 && positionSec / durationSec > 0.97;
    const barelyStarted = positionSec < 120;

    if (nearEnd) {
      s.progress[titleId] = {
        mediaIndex,
        positionSec: 0,
        durationSec,
        watched: true,
        lastPlayedAt: new Date().toISOString(),
      };
    } else if (barelyStarted) {
      delete s.progress[titleId];
    } else {
      s.progress[titleId] = {
        mediaIndex,
        positionSec,
        durationSec,
        watched: s.progress[titleId]?.watched ?? false,
        lastPlayedAt: new Date().toISOString(),
      };
    }
    await this.queueWrite();
  }

  /** Every episode resume point, keyed by contentId. */
  async getEpisodes(): Promise<Record<string, EpisodeProgress>> {
    return (await this.load()).episodes;
  }

  /**
   * Record where you are in an episode, and make it the show's latest.
   *
   * Same thresholds as `setProgress`, with one difference that matters for TV. Sampling
   * the first minute of episode 5 discards THAT episode's start — but it must not
   * touch the show's record, or "you finished episode 4" is forgotten and Continue
   * Watching loses its place.
   */
  async setEpisodeProgress(
    showId: string,
    contentId: string,
    positionSec: number,
    durationSec: number,
  ): Promise<void> {
    if (!isPosition(positionSec) || !isPosition(durationSec)) return;
    const s = await this.load();
    const now = new Date().toISOString();
    const existing = s.episodes[contentId];
    const nearEnd = durationSec > 0 && positionSec / durationSec > 0.97;
    const barelyStarted = positionSec < 120;

    if (nearEnd) {
      s.episodes[contentId] = { positionSec: 0, durationSec, watched: true, lastPlayedAt: now };
      s.progress[showId] = {
        contentId,
        mediaIndex: 0,
        positionSec: 0,
        durationSec,
        watched: true,
        lastPlayedAt: now,
      };
    } else if (barelyStarted) {
      // A rewatch abandoned early is still a watched episode.
      if (existing && !existing.watched) delete s.episodes[contentId];
    } else {
      s.episodes[contentId] = {
        positionSec,
        durationSec,
        watched: existing?.watched ?? false,
        lastPlayedAt: now,
      };
      s.progress[showId] = {
        contentId,
        mediaIndex: 0,
        positionSec,
        durationSec,
        watched: false,
        lastPlayedAt: now,
      };
    }
    await this.queueWrite();
  }

  /**
   * Every title's latest progress, watched or not, most recent first.
   *
   * `continueWatching` drops anything finished, which is right for a film and wrong
   * for a show: finishing episode 4 is exactly when episode 5 should be waiting.
   * Browse decides what each entry means; this only reports what happened.
   */
  async recentProgress(limit = 50): Promise<Array<{ titleId: string; progress: Progress }>> {
    const s = await this.load();
    return Object.entries(s.progress)
      .sort((a, b) => b[1].lastPlayedAt.localeCompare(a[1].lastPlayedAt))
      .slice(0, limit)
      .map(([titleId, progress]) => ({ titleId, progress }));
  }

  /** Continue Watching, most recent first. */
  async continueWatching(limit = 20): Promise<Array<{ titleId: string; progress: Progress }>> {
    const s = await this.load();
    return Object.entries(s.progress)
      .filter(([, p]) => !p.watched && p.positionSec > 0)
      .sort((a, b) => b[1].lastPlayedAt.localeCompare(a[1].lastPlayedAt))
      .slice(0, limit)
      .map(([titleId, progress]) => ({ titleId, progress }));
  }

  async toggleMyList(titleId: string): Promise<boolean> {
    const s = await this.load();
    const i = s.myList.indexOf(titleId);
    if (i >= 0) s.myList.splice(i, 1);
    else s.myList.unshift(titleId);
    await this.queueWrite();
    return i < 0;
  }

  async getMyList(): Promise<string[]> {
    return (await this.load()).myList;
  }

  async setThumb(titleId: string, value: 'up' | 'down' | null): Promise<void> {
    const s = await this.load();
    if (value === null) delete s.thumbs[titleId];
    else s.thumbs[titleId] = value;
    await this.queueWrite();
  }

  async getTracks(titleId: string): Promise<TrackChoice | null> {
    return (await this.load()).tracks[titleId] ?? null;
  }

  /**
   * Record a track choice. `undefined` for a field CLEARS it, which is how "let the
   * player decide" is expressed — not the same as subtitles off, which is `'no'`.
   */
  async setTracks(titleId: string, choice: TrackChoice): Promise<void> {
    const s = await this.load();
    const next: TrackChoice = { ...s.tracks[titleId], ...choice };
    if (choice.audio === undefined) delete next.audio;
    if (choice.subtitle === undefined) delete next.subtitle;

    if (next.audio === undefined && next.subtitle === undefined) delete s.tracks[titleId];
    else s.tracks[titleId] = next;

    await this.queueWrite();
  }

  /** Wait for pending writes — call before process exit. */
  async settle(): Promise<void> {
    await this.writeChain;
  }
}
