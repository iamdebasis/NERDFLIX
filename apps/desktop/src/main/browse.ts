/**
 * Browse data assembly and artwork serving.
 *
 * Artwork lives on the drive (or in the local cache when the drive is read-only), at
 * absolute paths the renderer must never see. A registered `media://` scheme keeps
 * `webSecurity` on and the renderer sandboxed — `file://` would mean disabling both.
 * See ARCHITECTURE.md §4.
 */

import { net, protocol } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MediaResolver,
  SIDECAR_DIR,
  type MetaStore,
  type StateStore,
  type Title,
  type VolumeState,
} from '@nfl/core';
import type { BrowseData, TitleCard } from '../shared/types.js';
import { buildRows } from './rows.js';

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

function describeAudio(title: Title): string | null {
  const track = title.media[0]?.audio?.[0];
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
  const progress = await state.continueWatching(50);
  const progressById = new Map(progress.map((p) => [p.titleId, p.progress]));

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
    if (poster?.startsWith(SIDECAR_DIR) && vol?.resolvedPath) {
      base = join(vol.resolvedPath, SIDECAR_DIR, 'artwork', t.id);
    } else if (poster) {
      base = join(poster, '..');
    }
    if (base) artworkIndex.set(t.id, base);

    const resume = progressById.get(t.id);

    return {
      id: t.id,
      title: t.title,
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
      resolution: media?.resolution ?? '',
      hdr: media?.hdr === 'DV' && media.dvProfile ? `DV P${media.dvProfile}` : (media?.hdr ?? 'SDR'),
      audio: describeAudio(t),
      sizeBytes: media?.sizeBytes ?? 0,
      bitrateMbps: media?.bitrateMbps ?? 0,
      available: availability.status === 'available',
      offlineOn: availability.status === 'offline' ? availability.volumeLabel : null,
      editions: t.media.map((m) => m.edition ?? 'Standard'),
      resumeSec: resume?.positionSec ?? null,
      resumePct:
        resume && resume.durationSec > 0
          ? Math.min(100, Math.max(0, (resume.positionSec / resume.durationSec) * 100))
          : null,
      watched: resume?.watched ?? false,
      inMyList: myList.includes(t.id),
    };
  });

  const rows = buildRows(cards, {
    continueIds: progress.map((p) => p.titleId),
    myListIds: myList,
  });

  // The hero wants a backdrop and, ideally, a logo to lay over it.
  const hero =
    cards.find((c) => c.backdrop && c.logo && c.available) ??
    cards.find((c) => c.backdrop) ??
    cards[0];

  return { titles: cards, rows, heroId: hero?.id ?? null };
}
