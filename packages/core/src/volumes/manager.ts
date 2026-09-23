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
import { dirname, join } from 'node:path';
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

/** Read volume identity via diskutil. Returns empty info off macOS. */
export async function inspectVolume(path: string): Promise<DiskInfo> {
  if (process.platform !== 'darwin') return { removable: false, readOnly: false };
  try {
    const { stdout } = await exec('diskutil', ['info', '-plist', path], {
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
      mountPoint: pick('MountPoint'),
      removable: flag('Removable') || flag('RemovableMedia') || flag('Ejectable'),
      readOnly: !flag('WritableVolume'),
    };
  } catch {
    return { removable: false, readOnly: false };
  }
}

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
  ) {}

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

  private async persist(): Promise<void> {
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

    const info = await inspectVolume(path);
    // A sentinel is any file we can re-check later to prove the mount is really ours
    // and not an empty directory left behind where the drive used to be.
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
    const id = deriveVolumeId(path, info);
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
   * Check one root. Tries the recorded path first, then relocates by UUID.
   * Always bounded by the probe timeout.
   */
  async probe(root: LibraryRoot): Promise<VolumeState> {
    const started = Date.now();

    const check = async (base: string): Promise<boolean> => {
      const target = root.sentinel ? join(base, root.sentinel) : base;
      await access(target);
      return true;
    };

    try {
      await withTimeout(check(root.path), this.probeTimeoutMs, root.label);
      return { root, status: 'online', resolvedPath: root.path, probeMs: Date.now() - started };
    } catch {
      /* fall through to UUID relocation */
    }

    if (root.volumeUUID) {
      try {
        const found = await withTimeout(
          findByUUID(root.volumeUUID),
          this.probeTimeoutMs * 3, // scanning /Volumes is slower than one access()
          `${root.label} (relocate)`,
        );
        if (found) {
          return {
            root,
            status: 'relocated',
            resolvedPath: found,
            probeMs: Date.now() - started,
          };
        }
      } catch {
        /* relocation failed too */
      }
    }

    return {
      root,
      status: 'offline',
      probeMs: Date.now() - started,
      error: 'not reachable',
    };
  }

  /** Probe every root in parallel — one sleeping NAS must not delay the others. */
  async probeAll(): Promise<VolumeState[]> {
    await this.load();
    return Promise.all(this.roots.map((r) => this.probe(r)));
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
