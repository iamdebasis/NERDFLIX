/**
 * Drive → mirror sync.
 *
 * Runs whenever a drive is reachable. Pulling the drive's own metadata into the local
 * mirror is what makes a second Mac work without rescanning: pair the drive, its
 * titles arrive, done. It is also what keeps unplugged drives visible, since the
 * mirror is all the app reads at render time.
 */

import type { MetaStore } from '../store/meta-store.js';
import type { VolumeState } from '../volumes/manager.js';
import { mergeTitles, readTitlesFromDrive, writeTitleToDrive } from './sidecar.js';
import type { Title } from '../schema/index.js';

export type SyncStats = {
  volumeId: string;
  label: string;
  pulled: number;
  pushed: number;
  skipped: number;
};

/**
 * Pull the drive's titles into the mirror, then push back anything the mirror knows
 * about this drive that the sidecar is missing.
 *
 * The push half matters for anyone who scanned before sidecars existed: their library
 * lives only in the mirror, and without this it would never become portable.
 */
export async function syncVolume(
  state: VolumeState,
  store: MetaStore,
  opts: { push?: boolean } = {},
): Promise<SyncStats | null> {
  if (state.status === 'offline' || !state.resolvedPath) return null;

  const volumeId = state.root.id;
  const stats: SyncStats = { volumeId, label: state.root.label, pulled: 0, pushed: 0, skipped: 0 };

  const fromDrive = await readTitlesFromDrive(state.resolvedPath);
  const { titles: mirror } = await store.loadAll();
  const mirrorById = new Map(mirror.map((t) => [t.id, t]));

  for (const incoming of fromDrive) {
    const existing = mirrorById.get(incoming.id) ?? null;
    const merged = mergeTitles(existing, incoming);

    // Nothing changed — avoid rewriting a file and retriggering the db watcher.
    if (existing && JSON.stringify(existing) === JSON.stringify(merged)) {
      stats.skipped += 1;
      continue;
    }

    await store.save(merged);
    mirrorById.set(merged.id, merged);
    stats.pulled += 1;
  }

  if (opts.push !== false) {
    const driveIds = new Set(fromDrive.map((t) => t.id));
    const owedToDrive: Title[] = [...mirrorById.values()].filter(
      (t) => !driveIds.has(t.id) && t.media.some((m) => m.sightings[0]?.volumeId === volumeId),
    );
    for (const t of owedToDrive) {
      if (await writeTitleToDrive(state.resolvedPath, volumeId, t)) stats.pushed += 1;
    }
  }

  return stats;
}

/** Borrowed and read-only drives are never written to — see VolumeManager.pair. */
function writable(state: { root: { borrowed?: boolean; readOnly?: boolean } }): boolean {
  return !state.root.borrowed && !state.root.readOnly;
}

export async function syncAll(
  states: VolumeState[],
  store: MetaStore,
  opts: { push?: boolean } = {},
): Promise<SyncStats[]> {
  const out: SyncStats[] = [];
  for (const s of states) {
    const r = await syncVolume(s, store, opts);
    if (r) out.push(r);
  }
  return out;
}
