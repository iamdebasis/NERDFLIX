/**
 * A show's episodes as slots, and which one "Play" means.
 *
 * Pure and React-free, like rows.ts and trailer-store.ts: every rule here is about
 * ORDER — which episode is next, which copy plays — and none of it is visible in a
 * screenshot until it is wrong. `episodes.test.ts` holds it still.
 */

import type { EpisodeInfo, EpisodeProgress, MediaFile, Title } from '../schema/index.js';

/**
 * One episode, however many files hold it.
 *
 * A slot rather than a file because the same episode can exist twice — a 1080p copy on
 * one drive and a 4K remux on another, which are different content and so different
 * media entries. The list shows ONE row for it, and Play picks the best reachable copy
 * of THAT episode — never a different episode that happens to be plugged in.
 */
export type EpisodeSlot = {
  /** `"1:4"`, stable across rescans — the renderer keys on it. */
  key: string;
  season: number;
  episode: number;
  episodeEnd?: number;
  files: MediaFile[];
  info?: EpisodeInfo;
};

export const slotKey = (season: number, episode: number) => `${season}:${episode}`;

/** Specials (season 0) sort after the regular seasons, as every TV service lists them. */
function seasonRank(season: number): number {
  return season === 0 ? Number.MAX_SAFE_INTEGER : season;
}

export function episodeSlots(title: Pick<Title, 'media' | 'episodeInfo'>): EpisodeSlot[] {
  const bySlot = new Map<string, EpisodeSlot>();

  for (const media of title.media) {
    if (media.season === undefined || media.episode === undefined) continue;
    const key = slotKey(media.season, media.episode);
    const slot =
      bySlot.get(key) ??
      ({ key, season: media.season, episode: media.episode, files: [] } as EpisodeSlot);
    slot.files.push(media);
    // A double episode in any copy makes the slot a double episode.
    if (media.episodeEnd && (!slot.episodeEnd || media.episodeEnd > slot.episodeEnd)) {
      slot.episodeEnd = media.episodeEnd;
    }
    bySlot.set(key, slot);
  }

  const infoByKey = new Map(title.episodeInfo.map((i) => [slotKey(i.season, i.episode), i]));
  const slots = [...bySlot.values()];
  for (const slot of slots) slot.info = infoByKey.get(slot.key);

  return slots.sort(
    (a, b) => seasonRank(a.season) - seasonRank(b.season) || a.episode - b.episode,
  );
}

/** The seasons present, in display order. */
export function seasonsOf(slots: readonly EpisodeSlot[]): number[] {
  return [...new Set(slots.map((s) => s.season))].sort((a, b) => seasonRank(a) - seasonRank(b));
}

/** A slot's own progress: the most recently played of its files. */
export function slotProgress(
  slot: EpisodeSlot,
  byContent: Readonly<Record<string, EpisodeProgress>>,
): EpisodeProgress | undefined {
  let best: EpisodeProgress | undefined;
  for (const f of slot.files) {
    const p = byContent[f.contentId];
    if (p && (!best || p.lastPlayedAt > best.lastPlayedAt)) best = p;
  }
  return best;
}

export type NextUp = {
  slot: EpisodeSlot;
  /**
   * - `resume`  — part-way through this episode; pick up where you left off
   * - `next`    — finished the previous one; this follows it
   * - `start`   — nothing watched yet
   * - `rewatch` — everything is watched; round again from the top
   */
  reason: 'resume' | 'next' | 'start' | 'rewatch';
  /** Seconds to resume from, when `reason` is `resume`. */
  resumeSec?: number;
  /** 0–100, for the progress bar. Only when resuming. */
  resumePct?: number;
};

/**
 * Which episode Play means.
 *
 * Follows what you actually did last, not "the first unwatched episode": someone who
 * skipped the pilot and is halfway through episode 3 wants episode 3. Specials never
 * come up on their own — they are side stories, and auto-advancing into one would
 * interrupt the season.
 */
export function nextUp(
  slots: readonly EpisodeSlot[],
  byContent: Readonly<Record<string, EpisodeProgress>>,
  lastContentId?: string,
): NextUp | null {
  if (slots.length === 0) return null;
  const regular = slots.filter((s) => s.season !== 0);
  const pool = regular.length > 0 ? regular : [...slots];

  const last = lastContentId
    ? slots.find((s) => s.files.some((f) => f.contentId === lastContentId))
    : undefined;

  if (last) {
    const p = slotProgress(last, byContent);
    if (p && !p.watched && p.positionSec > 0) {
      return {
        slot: last,
        reason: 'resume',
        resumeSec: p.positionSec,
        resumePct: p.durationSec > 0 ? Math.min(100, (p.positionSec / p.durationSec) * 100) : 0,
      };
    }
    // Finished (or sampled for seconds): the next unwatched episode AFTER it.
    const at = pool.indexOf(last);
    const after = (at >= 0 ? pool.slice(at + 1) : pool).find(
      (s) => !slotProgress(s, byContent)?.watched,
    );
    if (after) return { slot: after, reason: 'next' };
  }

  const firstUnwatched = pool.find((s) => !slotProgress(s, byContent)?.watched);
  if (firstUnwatched) {
    return { slot: firstUnwatched, reason: last || hasAnyWatched(pool, byContent) ? 'next' : 'start' };
  }
  return { slot: pool[0], reason: 'rewatch' };
}

function hasAnyWatched(
  slots: readonly EpisodeSlot[],
  byContent: Readonly<Record<string, EpisodeProgress>>,
): boolean {
  return slots.some((s) => slotProgress(s, byContent)?.watched);
}
