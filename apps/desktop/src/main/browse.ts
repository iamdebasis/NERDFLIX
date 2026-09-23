/**
 * Browse data assembly and artwork serving.
 *
 * Artwork lives on the drive (or in the local cache when the drive is read-only), at
 * absolute paths the renderer must never see. A registered `media://` scheme keeps
 * `webSecurity` on and the renderer sandboxed — `file://` would mean disabling both.
 * See ARCHITECTURE.md §4.
 */

import { net, protocol } from 'electron';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MediaResolver,
  SIDECAR_DIR,
  episodeSlots,
  type MediaFile,
  type MetaStore,
  type StateStore,
  type Title,
  type VolumeState,
} from '@nfl/core';
import type { BrowseData, TitleCard } from '../shared/types.js';
import { buildRows } from './rows.js';
import { hdrLabel, showSummary } from './shows.js';

/** titleId → absolute path on disk, rebuilt whenever the library is read. */
const artworkIndex = new Map<string, string>();

/**
 * Scheme privileges must be declared BEFORE app ready; `protocol.handle` only works
 * AFTER it. Splitting them is not optional — calling either at the wrong time throws.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    // media://art/<titleId>/<file>
    const url = new URL(request.url);
    const parts = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
    if (parts[0] !== 'art' || parts.length < 3) {
      return new Response('not found', { status: 404 });
    }

    const [, titleId, file] = parts;
    const base = artworkIndex.get(titleId);
    if (!base) return new Response('not found', { status: 404 });

    // Never let a crafted URL escape the artwork directory.
    if (file.includes('..') || file.includes('/')) {
      return new Response('forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(join(base, file)).toString());
  });
}

function artUrl(titleId: string, file: string, exists: boolean): string | null {
  return exists ? `media://art/${titleId}/${file}` : null;
}

function describeAudio(media: MediaFile | null | undefined): string | null {
  const track = media?.audio?.[0];
  if (!track) return null;
  const channels = track.channels === 8 ? '7.1' : track.channels === 6 ? '5.1' : `${track.channels}ch`;
  // macOS cannot bitstream object audio, so say what will actually come out.
  return track.objectAudio ? `${track.codec} ${channels} → PCM` : `${track.codec} ${channels}`;
}

export async function buildBrowseData(
  store: MetaStore,
  state: StateStore,
  states: VolumeState[],
  volumeId?: string,
): Promise<BrowseData> {
  const { titles } = await store.loadAll();
  const resolver = new MediaResolver(states);
  const myList = await state.getMyList();
  /*
   * Every title's latest progress, watched or not. This used to come from
   * `continueWatching()`, which drops watched titles before anything sees them — so
   * every card said `watched: false`, and the Unwatched filter could never split the
   * library. It is also what a show needs: finishing episode 4 is exactly when it
   * should be offering episode 5.
   */
  const recent = await state.recentProgress(5000);
  const lastById = new Map(recent.map((r) => [r.titleId, r.progress]));
  const byContent = await state.getEpisodes();

  artworkIndex.clear();

  const scoped = volumeId
    ? titles.filter((t) => t.media.some((m) => m.sightings.some((s) => s.volumeId === volumeId)))
    : titles;

  const cards: TitleCard[] = scoped.map((t) => {
    const availability = resolver.resolve(t);
    const media = t.media[0];

    // Artwork paths are stored relative to the drive when they live there, absolute
    // when they fell back to the local cache. Resolve both to one base directory.
    const vol = states.find((s) => s.root.id === media?.sightings[0]?.volumeId);
    let base: string | null = null;
    const poster = t.artwork.poster;
    // A show's episode stills are served from the same folder as its poster — and from
    // the stills' own folder when TMDB had no poster to download.
    const firstStill = t.episodeInfo.find((i) => i.still)?.still;
    if (poster?.startsWith(SIDECAR_DIR) && vol?.resolvedPath) {
      base = join(vol.resolvedPath, SIDECAR_DIR, 'artwork', t.id);
    } else if (poster) {
      base = join(poster, '..');
    } else if (firstStill) {
      base = dirname(firstStill);
    }
    if (base) artworkIndex.set(t.id, base);

    const last = lastById.get(t.id);
    const inProgress = last && !last.watched && last.positionSec > 0 ? last : undefined;

    const common = {
      id: t.id,
      title: t.title,
      sortTitle: t.sortTitle,
      year: t.year,
      tagline: t.tagline,
      overview: t.overview,
      genres: t.genres,
      runtimeMinutes: t.runtimeMinutes,
      // Already fetched and stored during enrichment; it was simply never surfaced.
      trailerUrl: t.trailer?.source === 'youtube' ? t.trailer.url : undefined,
      certification: t.certification,
      cast: t.cast.map((c) => c.name),
      directors: t.directors,
      collection: t.collection,
      addedAt: t.addedAt,
      poster: artUrl(t.id, 'poster.jpg', Boolean(t.artwork.poster)),
      backdrop: artUrl(t.id, 'backdrop.jpg', Boolean(t.artwork.backdrop)),
      logo: artUrl(t.id, 'logo.png', Boolean(t.artwork.logo)),
      inMyList: myList.includes(t.id),
    };

    if (t.type === 'show') {
      /*
       * A show's tile describes the episode Play would start — its resolution, HDR,
       * audio, reachability and progress — because that is what pressing it delivers.
       * Decided by the same `nextUp` that `library:play` uses, so they cannot disagree.
       */
      const { summary, playable } = showSummary(t, {
        resolver,
        byContent,
        lastContentId: last?.contentId,
      });
      const next = summary.nextUp;
      // Distinct content: the largest copy of each episode, never a copy counted twice.
      const sizeBytes = episodeSlots(t).reduce(
        (sum, slot) => sum + Math.max(...slot.files.map((f) => f.sizeBytes)),
        0,
      );
      return {
        ...common,
        type: 'show' as const,
        show: summary,
        resolution: playable?.resolution ?? '',
        hdr: hdrLabel(playable),
        audio: describeAudio(playable),
        sizeBytes,
        bitrateMbps: playable?.bitrateMbps ?? 0,
        available: next?.available ?? false,
        offlineOn: next?.offlineOn ?? null,
        editions: [],
        resumeSec: null,
        resumePct: next?.resumePct ?? null,
        // "Watched" for a show means every episode, which is when next-up starts over.
        watched: next?.reason === 'rewatch',
      };
    }

    return {
      ...common,
      type: 'movie' as const,
      resolution: media?.resolution ?? '',
      hdr: hdrLabel(media),
      audio: describeAudio(media),
      sizeBytes: media?.sizeBytes ?? 0,
      bitrateMbps: media?.bitrateMbps ?? 0,
      available: availability.status === 'available',
      offlineOn: availability.status === 'offline' ? availability.volumeLabel : null,
      editions: t.media.map((m) => m.edition ?? 'Standard'),
      resumeSec: inProgress?.positionSec ?? null,
      resumePct:
        inProgress && inProgress.durationSec > 0
          ? Math.min(100, Math.max(0, (inProgress.positionSec / inProgress.durationSec) * 100))
          : null,
      watched: last?.watched ?? false,
    };
  });

  /*
   * Continue Watching, most recent first: a film part-way through, or a show with an
   * episode to resume or one waiting after the last. A show watched to the end is
   * finished, and does not belong here.
   */
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const continueIds = recent
    .filter((r) => {
      const card = cardById.get(r.titleId);
      if (!card) return false;
      if (card.type === 'show') {
        const reason = card.show?.nextUp?.reason;
        return reason === 'resume' || reason === 'next';
      }
      return !r.progress.watched && r.progress.positionSec > 0;
    })
    .map((r) => r.titleId);

  const rows = buildRows(cards, { continueIds, myListIds: myList });

  // The hero wants a backdrop and, ideally, a logo to lay over it.
  const hero =
    cards.find((c) => c.backdrop && c.logo && c.available) ??
    cards.find((c) => c.backdrop) ??
    cards[0];

  return { titles: cards, rows, heroId: hero?.id ?? null };
}
