/**
 * Volume management. See ARCHITECTURE.md §6.
 *
 * The core idea: a path is a hint, a volume UUID is an identity. `/Volumes/XBOXCapture`
 * today can be `/Volumes/XBOXCapture 1` tomorrow after an unclean eject, and a NAS
 * remounts under whatever name it likes. Storing a path string and hoping is the
 * difference between "it remembers the folder" working and not.
 */

import { constants, watch, type FSWatcher } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { VolumeStoreSchema, type LibraryRoot } from '../schema/index.js';

const exec = promisify(execFile);

export type VolumeStatus = 'online' | 'offline' | 'relocated';

export type VolumeState = {
  root: LibraryRoot;
  status: VolumeStatus;
  /** Where it actually is right now, which may differ from root.path. */
  resolvedPath?: string;
  probeMs: number;
  error?: string;
};

/**
 * Wrap a promise in a hard timeout.
 *
 * Not a nicety. An unreachable SMB mount makes a naive fs.access block for 30+
 * seconds, which would hang the splash screen on every launch where the NAS is
 * asleep. See §6.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// --- macOS volume identity ---------------------------------------------------

export type DiskInfo = {
  volumeUUID?: string;
  fileSystem?: string;
  /** Where the volume itself is mounted, which may be above the library folder. */
  mountPoint?: string;
  removable: boolean;
  readOnly: boolean;
};

/**
 * The mount point of the volume holding `path`.
 *
 * `df -P` answers for any path; `diskutil info` only for a mount point or a device.
 */
async function mountPointOf(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('df', ['-P', path]);
    // Filesystem  512-blocks  Used  Available  Capacity  Mounted-on — and the mount
    // point is everything after the capacity column, because it may contain spaces.
    return stdout.trim().split('\n')[1]?.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Read the identity of the volume a path lives on. Returns empty info off macOS.
 *
 * Asks about the VOLUME, not the path. `diskutil info` fails for anything that is not a
 * mount point, and it used to be handed the library folder itself — so every library
 * that was a folder on a drive (`/Volumes/XBOXCapture/MOVIEX`) or on the Mac
 * (`~/Documents/DOC`) was paired with no volume UUID at all, which left one sentinel
 * file as the only proof the drive was there.
 */
export async function inspectVolume(path: string): Promise<DiskInfo> {
  if (process.platform !== 'darwin') return { removable: false, readOnly: false };
  const mount = await mountPointOf(path);
  try {
    const { stdout } = await exec('diskutil', ['info', '-plist', mount ?? path], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const pick = (key: string): string | undefined => {
      const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
      return stdout.match(re)?.[1];
    };
    const flag = (key: string): boolean =>
      new RegExp(`<key>${key}</key>\\s*<true/>`).test(stdout);

    return {
      volumeUUID: pick('VolumeUUID'),
      fileSystem: pick('FilesystemName') ?? pick('FilesystemType'),
      mountPoint: pick('MountPoint') || mount,
      removable: flag('Removable') || flag('RemovableMedia') || flag('Ejectable'),
      readOnly: !flag('WritableVolume'),
    };
  } catch {
    // A NAS share, say, which diskutil will not describe: the mount point still helps.
    return { mountPoint: mount, removable: false, readOnly: false };
  }
}

/** The library folder's path inside its volume, when the volume's mount point contains it. */
export function volumePathOf(path: string, mountPoint?: string): string | undefined {
  if (!mountPoint) return undefined;
  if (path === mountPoint) return '';
  const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
  return path.startsWith(prefix) ? relative(mountPoint, path) : undefined;
}

const exists = (p: string) => access(p).then(
  () => true,
  () => false,
);

/** Find where a known volume UUID is mounted right now. */
export async function findByUUID(uuid: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const entries = await readdir('/Volumes');
    for (const name of entries) {
      const candidate = join('/Volumes', name);
      const info = await inspectVolume(candidate);
      if (info.volumeUUID && info.volumeUUID === uuid) return candidate;
    }
  } catch {
    /* no /Volumes, or unreadable */
  }
  return null;
}

/**
 * Deterministic volume id.
 *
 * Ids used to be random, which quietly broke re-pairing: remove a library and add the
 * same folder back and it got a fresh id, orphaning every title record that referenced
 * the old one. Those titles then resolved as 'missing' forever while the rescan created
 * duplicates alongside them.
 *
 * Keyed on the volume UUID plus the library folder's path *within* that volume, so the
 * same folder on the same drive always produces the same id — across re-pairing, across
 * remounts under a different name, and across machines. Falls back to the absolute path
 * when the filesystem reports no UUID (exFAT sometimes does not).
 */
export function deriveVolumeId(path: string, info: DiskInfo): string {
  const key =
    info.volumeUUID && info.mountPoint && path.startsWith(info.mountPoint)
      ? `${info.volumeUUID}:${path.slice(info.mountPoint.length) || '/'}`
      : info.volumeUUID
        ? `${info.volumeUUID}:${path}`
        : path;
  return `vol-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
}

// --- Store -------------------------------------------------------------------

/**
 * Could we write here? Informational only — see `pair`.
 *
 * Asked with access(2), NOT by writing a probe file. This used to create and delete
 * `.nfl-write-test-<pid>` on the drive to find out, which is a write to a drive we
 * promise never to write to, and it moves the folder's modification time. access()
 * reports both missing permission and a read-only filesystem (EROFS) without touching
 * anything.
 */
async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class VolumeManager {
  private roots: LibraryRoot[] = [];
  private watcher?: FSWatcher;
  private loaded = false;

  constructor(
    private readonly storePath: string,
    private readonly probeTimeoutMs = 2000,
    /** Tests stand in for diskutil and /Volumes; the app uses the real ones. */
    private readonly deps: { inspect?: typeof inspectVolume; findByUUID?: typeof findByUUID } = {},
  ) {}

  private inspect(path: string): Promise<DiskInfo> {
    return (this.deps.inspect ?? inspectVolume)(path);
  }

  /** Writes queue: two probes repairing the same record must not race over the file. */
  private writing: Promise<void> = Promise.resolve();

  async load(): Promise<LibraryRoot[]> {
    if (this.loaded) return this.roots;
    try {
      const raw = JSON.parse(await readFile(this.storePath, 'utf8'));
      this.roots = VolumeStoreSchema.parse(raw).roots;
    } catch {
      this.roots = [];
    }
    this.loaded = true;
    return this.roots;
  }

  private persist(): Promise<void> {
    const run = this.writing.then(() => this.writeNow());
    this.writing = run.catch(() => {});
    return run;
  }

  private async writeNow(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({ version: 1, roots: this.roots }, null, 2) + '\n',
      'utf8',
    );
    await rename(tmp, this.storePath);
  }

  /**
   * Pair a directory as a library root, capturing its volume identity now so it can
   * be found again after a remount.
   */
  async pair(
    path: string,
    label?: string,
    opts?: { borrowed?: boolean },
  ): Promise<LibraryRoot> {
    await this.load();
    const s = await stat(path);
    if (!s.isDirectory()) throw new Error(`${path} is not a directory`);

    const info = await this.inspect(path);
    // A hint that the folder is really there — see `identify` for why only a hint.
    const sentinel = await pickSentinel(path);

    /**
     * Identity is derived, never read from or written to the drive: a hash of the
     * volume UUID plus the path within it, or of the mount path when the filesystem
     * reports no UUID (exFAT often does not). Deterministic, so re-pairing the same
     * folder finds the same record. Files themselves are recognised by content
     * (`contentId`), so nothing needs to be stored on the drive for a library to be
     * recognised again. An identity file from a pre-release build (`.netflix-local/`)
     * is ignored; no released version ever wrote one.
     */
    //
    // Re-pairing a folder already paired keeps its id: older pairings derived it with
    // no volume UUID (diskutil was never asked about the volume), and deriving it
    // afresh now would give the same folder a new id and orphan every sighting of it.
    const sameFolder = this.roots.find((r) => r.path === path);
    const id = sameFolder?.id ?? deriveVolumeId(path, info);
    const resolvedLabel = label ?? path.split('/').filter(Boolean).pop() ?? path;

    /**
     * Nothing is ever written to a scanned drive — not an identity file, not artwork,
     * not metadata. Everything lives in the project's own data directory.
     *
     * This used to be conditional on whether the drive was ours and writable, and
     * those conditions produced both bugs and a question the user should never have
     * been asked. Files are identified by their content, so a drive needs no marking
     * to be recognised again; writing to it only ever saved a scan we can afford to
     * redo.
     */
    const writable = await isWritable(path);

    const root: LibraryRoot = {
      id,
      label: resolvedLabel,
      kind: info.removable ? 'removable' : 'local',
      path,
      // Informational only — nothing is written to any drive regardless.
      readOnly: !writable,
      borrowed: false,
      volumeUUID: info.volumeUUID,
      fileSystem: info.fileSystem,
      volumePath: volumePathOf(path, info.mountPoint),
      sentinel,
      addedAt: new Date().toISOString(),
    };

    // Re-pairing an existing folder replaces its record rather than adding a second
    // one, which the deterministic id now makes detectable.
    const existing = this.roots.findIndex((r) => r.id === root.id);
    if (existing >= 0) this.roots[existing] = { ...this.roots[existing], ...root };
    else this.roots.push(root);
    await this.persist();
    return root;
  }

  /** Change flags on a paired root — currently only `borrowed`. */
  async update(id: string, patch: { borrowed?: boolean }): Promise<boolean> {
    await this.load();
    const root = this.roots.find((r) => r.id === id);
    if (!root) return false;
    if (patch.borrowed !== undefined) root.borrowed = patch.borrowed;
    await this.persist();
    return true;
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.roots = this.roots.filter((r) => r.id !== id);
    await this.persist();
  }

  /**
   * Is the library in reach, and where? Tries the recorded path first, then finds the
   * drive by UUID wherever it is mounted now. Always bounded by the probe timeout.
   */
  async probe(root: LibraryRoot): Promise<VolumeState> {
    const started = Date.now();
    const state = (status: VolumeStatus, resolvedPath?: string): VolumeState => ({
      root,
      status,
      resolvedPath,
      probeMs: Date.now() - started,
      ...(status === 'offline' ? { error: 'not reachable' } : {}),
    });

    try {
      const here = await withTimeout(this.identify(root, root.path), this.probeTimeoutMs, root.label);
      if (here === 'ours') return state('online', root.path);
    } catch {
      /* not answering in time — a sleeping NAS; try elsewhere */
    }

    if (root.volumeUUID) {
      try {
        const mount = await withTimeout(
          (this.deps.findByUUID ?? findByUUID)(root.volumeUUID),
          this.probeTimeoutMs * 3, // scanning /Volumes is slower than one stat()
          `${root.label} (relocate)`,
        );
        // The library FOLDER inside the drive, not the drive's top level — which is
        // what used to be returned, pointing a subfolder library at the whole drive.
        const candidate = mount ? join(mount, root.volumePath ?? '') : null;
        if (candidate && candidate !== root.path) {
          const there = await withTimeout(this.identify(root, candidate), this.probeTimeoutMs, root.label);
          if (there === 'ours') return state('relocated', candidate);
        }
      } catch {
        /* relocation failed too */
      }
    }

    return state('offline');
  }

  /**
   * Is the library at `base` right now?
   *
   * Strongest proof first: the volume UUID — a drive is itself, whatever is on it. Then
   * the sentinel. Then a folder that still holds something. That last rule is the fix
   * for a real report: the sentinel is ONE entry picked at pairing, and moving it into a
   * subfolder while reorganising a drive made a plugged-in drive read "Not connected".
   * Reorganising changes what is on a drive, not whether it is there.
   */
  private async identify(root: LibraryRoot, base: string): Promise<'ours' | 'other' | 'absent'> {
    const s = await stat(base).catch(() => null);
    if (!s?.isDirectory()) return 'absent';

    if (root.volumeUUID) {
      const info = await this.inspect(base);
      if (info.volumeUUID) return info.volumeUUID === root.volumeUUID ? 'ours' : 'other';
      // The filesystem would not say (some never do): judge by what is there instead.
    }

    // A mount point left behind — a folder under /Volumes that sits on the startup disk
    // itself — is not the drive, whatever it holds.
    if (base.startsWith('/Volumes/')) {
      const system = await stat('/').catch(() => null);
      if (system && system.dev === s.dev) return 'absent';
    }

    if (root.sentinel && (await exists(join(base, root.sentinel)))) return 'ours';
    const entries = await readdir(base).catch(() => [] as string[]);
    return entries.some((name) => !name.startsWith('.')) ? 'ours' : 'absent';
  }

  /** Probe every root in parallel — one sleeping NAS must not delay the others. */
  async probeAll(): Promise<VolumeState[]> {
    await this.load();
    const states = await Promise.all(this.roots.map((r) => this.probe(r)));
    // Never fails a probe: a record that cannot be improved now is improved next time.
    await this.repair(states).catch(() => {});
    return states;
  }

  /**
   * Complete what an older pairing never recorded, once the library is in reach.
   *
   * Every library that is a folder rather than a whole drive was paired without a
   * volume UUID (diskutil was asked about the folder, and answers only for a volume),
   * so it could not be found under a new mount name, and one sentinel was the only
   * proof it was there. A sentinel that has moved is replaced, so it means something
   * again. The id is never touched: every sighting of every file refers to it.
   */
  private async repair(states: VolumeState[]): Promise<void> {
    let changed = false;
    for (const s of states) {
      if (s.status === 'offline' || !s.resolvedPath) continue;
      const root = s.root;
      if (!root.volumeUUID) {
        const info = await withTimeout(this.inspect(s.resolvedPath), this.probeTimeoutMs, root.label).catch(
          () => null,
        );
        if (info?.volumeUUID) {
          root.volumeUUID = info.volumeUUID;
          root.fileSystem ??= info.fileSystem;
          root.volumePath = volumePathOf(s.resolvedPath, info.mountPoint);
          changed = true;
        }
      }
      if (!root.sentinel || !(await exists(join(s.resolvedPath, root.sentinel)))) {
        const fresh = await pickSentinel(s.resolvedPath);
        if (fresh && fresh !== root.sentinel) {
          root.sentinel = fresh;
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
  }

  /** Persist a relocation so the next launch tries the right path first. */
  async commitRelocation(id: string, newPath: string): Promise<void> {
    await this.load();
    const root = this.roots.find((r) => r.id === id);
    if (!root || root.path === newPath) return;
    root.path = newPath;
    await this.persist();
  }

  /**
   * Live mount/unmount detection.
   *
   * macOS mounts appear and disappear as entries in /Volumes, so watching that
   * directory gives instant events instead of polling. Electron has no equivalent
   * of NSWorkspace's mount notifications, and this is the practical substitute.
   */
  watchMounts(onChange: () => void): () => void {
    if (process.platform !== 'darwin') return () => {};
    try {
      let debounce: NodeJS.Timeout | undefined;
      this.watcher = watch('/Volumes', () => {
        // Mounting fires several events; coalesce them.
        clearTimeout(debounce);
        debounce = setTimeout(onChange, 400);
      });
      return () => {
        clearTimeout(debounce);
        this.watcher?.close();
        this.watcher = undefined;
      };
    } catch {
      return () => {};
    }
  }

  get all(): LibraryRoot[] {
    return this.roots;
  }
}

/** Choose a small, stable file to use as proof-of-mount. */
async function pickSentinel(path: string): Promise<string | undefined> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const named = entries.find((e) => !e.name.startsWith('.'));
    return named?.name;
  } catch {
    return undefined;
  }
}
