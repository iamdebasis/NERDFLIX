/**
 * Where can this title actually be played from, right now?
 *
 * A media file has *sightings* — places it has been observed — rather than a single
 * home. Resolving means picking the best sighting that is reachable at this moment,
 * which is what lets the same film live on your drive and a borrowed one and simply
 * play from whichever is attached.
 */

import { join } from 'node:path';
import type { MediaFile, Title } from '../schema/index.js';
import type { VolumeState } from '../volumes/manager.js';

export type Availability =
  | { status: 'available'; media: MediaFile; absolutePath: string; volumeLabel: string }
  | { status: 'offline'; media: MediaFile; volumeLabel: string }
  | { status: 'missing' };

export class MediaResolver {
  private readonly online = new Map<string, { path: string; label: string }>();
  private readonly known = new Map<string, string>();

  constructor(states: VolumeState[]) {
    for (const s of states) {
      this.known.set(s.root.id, s.root.label);
      if (s.status !== 'offline' && s.resolvedPath) {
        this.online.set(s.root.id, { path: s.resolvedPath, label: s.root.label });
      }
    }
  }

  /**
   * Prefer a playable copy over a better one that is not plugged in.
   *
   * Among playable copies, prefer the highest bitrate — that is the better transfer.
   * A 4K remux you cannot reach is worth less than a 1080p one you can.
   */
  resolve(title: Title, preferIndex?: number): Availability {
    if (title.media.length === 0) return { status: 'missing' };

    if (preferIndex !== undefined) {
      const wanted = title.media[preferIndex];
      if (wanted) {
        const found = this.locate(wanted);
        if (found) return found;
      }
    }

    const playable: Availability[] = [];
    const offline: Availability[] = [];

    for (const media of title.media) {
      const found = this.locate(media);
      if (found) {
        playable.push(found);
        continue;
      }
      // Not reachable now, but do we at least know which drive to ask for?
      const sighting = media.sightings[0];
      const label = sighting ? this.known.get(sighting.volumeId) : undefined;
      if (label) offline.push({ status: 'offline', media, volumeLabel: label });
    }

    if (playable.length > 0) {
      playable.sort((a, b) => {
        const am = a.status === 'available' ? a.media.bitrateMbps : 0;
        const bm = b.status === 'available' ? b.media.bitrateMbps : 0;
        return bm - am;
      });
      return playable[0];
    }

    return offline[0] ?? { status: 'missing' };
  }

  /** The first sighting of this file on a drive that is attached right now. */
  private locate(media: MediaFile): Availability | null {
    for (const sighting of media.sightings) {
      const vol = this.online.get(sighting.volumeId);
      if (!vol) continue;
      return {
        status: 'available',
        media,
        absolutePath: join(vol.path, sighting.relPath),
        volumeLabel: vol.label,
      };
    }
    return null;
  }

  /** Counts for the library listing: how much is reachable right now. */
  summary(titles: Title[]): { available: number; offline: number; missing: number } {
    let available = 0;
    let offline = 0;
    let missing = 0;
    for (const t of titles) {
      const a = this.resolve(t);
      if (a.status === 'available') available += 1;
      else if (a.status === 'offline') offline += 1;
      else missing += 1;
    }
    return { available, offline, missing };
  }

  /** Volumes a title depends on, for "you'll need MOVIEX plugged in" messaging. */
  volumesFor(title: Title): string[] {
    const ids = new Set<string>();
    for (const m of title.media) for (const s of m.sightings) ids.add(s.volumeId);
    return [...ids].map((id) => this.known.get(id) ?? id);
  }
}
