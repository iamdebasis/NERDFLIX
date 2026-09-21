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
import { StateFileSchema, type Progress, type StateFile } from '../schema/index.js';

const EMPTY: StateFile = { version: 1, progress: {}, myList: [], thumbs: {} };

export class StateStore {
  private cache?: StateFile;
  /** Serialises writes so two rapid progress saves cannot interleave. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<StateFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.cache = StateFileSchema.parse(raw);
    } catch {
      // Missing or corrupt state must never block playback. Start clean.
      this.cache = structuredClone(EMPTY);
    }
    return this.cache;
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

  /** Wait for pending writes — call before process exit. */
  async settle(): Promise<void> {
    await this.writeChain;
  }
}
