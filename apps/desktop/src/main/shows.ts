/**
 * A show, as the renderer sees it: a tile summary, and an episode list on demand.
 *
 * Separate from browse.ts so it can be tested without Electron, and because every
 * decision here — which episode Play means, which copy of it plays, whether it is
 * reachable — has to agree with what `library:play` then does. Both call into the same
 * core functions (`episodeSlots`, `nextUp`, `resolveAmong`) so they cannot drift.
 */

import { basename } from 'node:path';
import {
  episodeLabel,
  episodeSlots,
  isYearSeason,
  nextUp,
  seasonsOf,
  slotProgress,
  type EpisodeProgress,
  type EpisodeSlot,
  type MediaFile,
  type MediaResolver,
  type Title,
} from '@nfl/core';
import type { EpisodeRow, SeasonRow, ShowEpisodes, ShowSummary } from '../shared/types.js';

/** `DV P8`, `HDR10`, `SDR` — what the file actually is, for a badge. */
export function hdrLabel(media: MediaFile | null | undefined): string {
  if (!media) return 'SDR';
  return media.hdr === 'DV' && media.dvProfile ? `DV P${media.dvProfile}` : media.hdr;
}

/** A served URL for a local artwork file of this title. Same scheme as posters. */
export function artworkUrl(titleId: string, localPath: string | undefined): string | null {
  return localPath ? `media://art/${titleId}/${basename(localPath)}` : null;
}

type SlotState = {
  available: boolean;
  offlineOn: string | null;
  /** The copy that would play: the best reachable one, else the one we know about. */
  file: MediaFile;
};

/**
 * Where one episode is. Resolved among ITS OWN copies only — see
 * `MediaResolver.resolveAmong` for the wrong-episode bug this exists to prevent.
 */
function slotState(slot: EpisodeSlot, resolver: MediaResolver): SlotState {
  const a = resolver.resolveAmong(slot.files);
  return {
    available: a.status === 'available',
    offlineOn: a.status === 'offline' ? a.volumeLabel : null,
    file: a.status === 'missing' ? slot.files[0] : a.media,
  };
}

/** Never empty: TMDB's name, the filename's, or "Episode 4". */
function episodeName(slot: EpisodeSlot): string {
  return (
    slot.info?.name ||
    slot.files.find((f) => f.episodeTitle)?.episodeTitle ||
    (slot.episodeEnd ? `Episodes ${slot.episode}–${slot.episodeEnd}` : `Episode ${slot.episode}`)
  );
}

function seasonName(title: Title, season: number): string {
  return (
    title.seasonInfo.find((s) => s.season === season)?.name ||
    (season === 0 ? 'Specials' : `Season ${season}`)
  );
}

function resumePctOf(p: EpisodeProgress | undefined): number | null {
  if (!p || p.watched || p.positionSec <= 0 || p.durationSec <= 0) return null;
  return Math.min(100, Math.max(0, (p.positionSec / p.durationSec) * 100));
}

/**
 * How many seasons are ON YOUR DRIVES, said so it cannot be misread.
 *
 * "2 Seasons" for several. For exactly one, the season's own name — "Season 2" —
 * because "1 Season" reads as a claim about the SHOW: owning season 2 of The Office's
 * nine printed "1 Season" beside a nine-season series. A one-season show TMDB calls a
 * miniseries is "Limited Series", which is what Netflix prints for Chernobyl.
 *
 * One season numbered by a YEAR says nothing as a name — Tom and Jerry's "Season 1940"
 * beside "1940–1949" — so it is counted instead: "46 Episodes", as Netflix prints for
 * a collection.
 */
export function seasonsLabel(
  title: Pick<Title, 'seasonInfo'>,
  regularSeasons: readonly number[],
  episodeCount = 0,
): string {
  if (regularSeasons.length === 0) return 'Specials';
  if (regularSeasons.length === 1) {
    const season = regularSeasons[0];
    if (isYearSeason(season) && episodeCount > 0) {
      return `${episodeCount} ${episodeCount === 1 ? 'Episode' : 'Episodes'}`;
    }
    const name = title.seasonInfo.find((s) => s.season === season)?.name ?? '';
    if (/mini-?series|limited/i.test(name)) return 'Limited Series';
    return /^season \d+$/i.test(name) ? name : `Season ${season}`;
  }
  return `${regularSeasons.length} Seasons`;
}

export type ShowContext = {
  resolver: MediaResolver;
  /** Every episode resume point, keyed by contentId. */
  byContent: Readonly<Record<string, EpisodeProgress>>;
  /** The episode last touched, from the show's own progress record. */
  lastContentId?: string;
};

/**
 * The tile-level summary, plus the file that next-up would play — whose resolution, HDR
 * and audio the tile should show, since that is what pressing Play delivers.
 */
export function showSummary(
  title: Title,
  ctx: ShowContext,
): { summary: ShowSummary; playable: MediaFile | null } {
  const slots = episodeSlots(title);
  const regularSeasons = seasonsOf(slots).filter((s) => s !== 0);

  const yearLabel = title.year
    ? title.endYear && title.endYear !== title.year
      ? `${title.year}–${title.endYear}`
      : String(title.year)
    : undefined;

  const next = nextUp(slots, ctx.byContent, ctx.lastContentId);
  let playable: MediaFile | null = null;
  let nextUpCard: ShowSummary['nextUp'] = null;

  if (next) {
    const state = slotState(next.slot, ctx.resolver);
    playable = state.file;
    nextUpCard = {
      key: next.slot.key,
      label: episodeLabel(next.slot),
      name: episodeName(next.slot),
      reason: next.reason,
      resumePct: next.reason === 'resume' ? (next.resumePct ?? 0) : null,
      available: state.available,
      offlineOn: state.offlineOn,
    };
  }

  return {
    summary: {
      seasonCount: regularSeasons.length,
      seasonsLabel: seasonsLabel(title, regularSeasons, slots.length),
      episodeCount: slots.length,
      creators: title.creators,
      yearLabel,
      nextUp: nextUpCard,
      episodesAsFilms: title.episodesAsFilms === true,
    },
    playable,
  };
}

/** The detail view's seasons and episode rows. */
export function showEpisodes(title: Title, ctx: ShowContext): ShowEpisodes {
  const slots = episodeSlots(title);

  const seasons: SeasonRow[] = seasonsOf(slots).map((season) => {
    const info = title.seasonInfo.find((s) => s.season === season);
    return {
      season,
      name: seasonName(title, season),
      owned: slots.filter((s) => s.season === season).length,
      total: info?.episodeCount,
      airYear: info?.airYear,
    };
  });

  const episodes: EpisodeRow[] = slots.map((slot) => {
    const state = slotState(slot, ctx.resolver);
    const progress = slotProgress(slot, ctx.byContent);
    return {
      key: slot.key,
      season: slot.season,
      episode: slot.episode,
      episodeEnd: slot.episodeEnd,
      label: episodeLabel(slot),
      number: slot.episodeEnd ? `${slot.episode}–${slot.episodeEnd}` : String(slot.episode),
      name: episodeName(slot),
      overview: slot.info?.overview,
      // TMDB's runtime is the episode's; the file's duration is the fallback.
      runtimeMinutes: slot.info?.runtimeMinutes ?? Math.round(state.file.durationSec / 60),
      airDate: slot.info?.airDate,
      still: artworkUrl(title.id, slot.info?.still),
      available: state.available,
      offlineOn: state.offlineOn,
      resumePct: resumePctOf(progress),
      watched: progress?.watched ?? false,
      resolution: state.file.resolution,
      hdr: hdrLabel(state.file),
    };
  });

  const next = nextUp(slots, ctx.byContent, ctx.lastContentId);
  return { seasons, episodes, nextUpKey: next?.slot.key ?? null };
}

/**
 * What `library:play` should start for a show: the requested episode, or next-up.
 *
 * Shared with the tile so the button's label and the thing that plays are decided by
 * the same code. Returns the slot, and — separately — where to resume, which is only
 * ever that episode's own progress.
 */
export function episodeToPlay(
  title: Title,
  ctx: ShowContext,
  episodeKey?: string,
): { slot: EpisodeSlot; resumeSec?: number } | null {
  const slots = episodeSlots(title);
  if (episodeKey) {
    const slot = slots.find((s) => s.key === episodeKey);
    if (!slot) return null;
    const p = slotProgress(slot, ctx.byContent);
    return { slot, resumeSec: p && !p.watched && p.positionSec > 0 ? p.positionSec : undefined };
  }
  const next = nextUp(slots, ctx.byContent, ctx.lastContentId);
  return next ? { slot: next.slot, resumeSec: next.resumeSec } : null;
}
