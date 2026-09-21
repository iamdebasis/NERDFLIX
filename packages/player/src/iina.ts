/**
 * Playback through IINA instead of a bare mpv process.
 *
 * Why this exists: on this hardware IINA's HDR is visibly better than anything mpv can
 * be configured into. Five approaches were measured and rejected — passthrough
 * signalling, `--target-peak`, MoltenVK via `macvk`, mpv's native `cocoa-cb` Metal
 * backend, and explicit `--target-trc=pq --target-prim=bt.2020`. None closed the gap.
 *
 * The remaining difference is architectural rather than configurable. IINA hosts
 * libmpv and draws frames itself, so it owns the `CAMetalLayer` and sets
 * `wantsExtendedDynamicRangeContent` directly. A standalone mpv process can only ask
 * the compositor for EDR headroom indirectly, and on macOS that is evidently weaker.
 *
 * So: let IINA render, and keep everything this project actually is. Underneath, IINA
 * IS mpv, so the same JSON IPC gives us resume tracking, verified status reporting and
 * quality adaptation. Nothing is surrendered except who draws the pixels.
 *
 * THE ONE MANUAL STEP: `iina-cli` deliberately ignores `--input-*` options, so the IPC
 * socket cannot be passed per launch. It must be set once in IINA's own preferences —
 * Advanced → "Additional mpv options" — as:
 *
 *     input-ipc-server=/tmp/nerdflix-iina.sock
 *
 * This is the same thing SVP users do. Without it we can launch films but cannot track
 * progress, so the engine refuses to start rather than silently losing watch history.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { MpvIpc, MpvIpcError } from './mpv-ipc.js';
import type { MpvPropertyChange } from './mpv-ipc.js';
import type {
  LoadOptions,
  MpvProp,
  MpvPropertyMap,
  PlaybackEngine,
  SeekMode,
  TrackId,
  TrackType,
  Unsub,
} from './engine.js';

const exec = promisify(execFile);

/** Where IINA is asked to put its IPC socket. Must match IINA's own preferences. */
export const DEFAULT_IINA_SOCKET = '/tmp/nerdflix-iina.sock';

/** Standard install location, used when `iina-cli` is not on PATH. */
const BUNDLED_CLI = '/Applications/IINA.app/Contents/MacOS/iina-cli';

export type IinaOptions = {
  /** Must match `input-ipc-server` in IINA's Additional mpv options. */
  socketPath?: string;
  cliPath?: string;
  onExit?: () => void;
};

export class IinaNotConfiguredError extends Error {
  constructor(socketPath: string) {
    super(
      `IINA is not exposing an IPC socket at ${socketPath}.\n\n` +
        `Open IINA → Settings → Advanced, tick "Enable advanced settings", and add to\n` +
        `"Additional mpv options":\n\n` +
        `    input-ipc-server=${socketPath}\n\n` +
        `Then quit IINA completely and try again. Without this, films would play but\n` +
        `watch progress could not be tracked.`,
    );
    this.name = 'IinaNotConfiguredError';
  }
}

/** Locate `iina-cli`, preferring PATH so a non-standard install still works. */
export async function findIinaCli(explicit?: string): Promise<string | null> {
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await exec('which', ['iina-cli']);
    const p = stdout.trim();
    if (p) return p;
  } catch {
    /* not on PATH */
  }
  try {
    await access(BUNDLED_CLI);
    return BUNDLED_CLI;
  } catch {
    return null;
  }
}

type Observer = { observeId: number; cb: (value: unknown) => void };

export class IinaEngine implements PlaybackEngine {
  private ipc: MpvIpc | null = null;
  private cli: string | null = null;
  private readonly socketPath: string;
  private readonly observers = new Map<number, Observer>();
  private nextObserveId = 1;

  constructor(private readonly opts: IinaOptions = {}) {
    this.socketPath = opts.socketPath ?? DEFAULT_IINA_SOCKET;
  }

  get ipcSocketPath(): string {
    return this.socketPath;
  }

  async start(): Promise<void> {
    this.cli = await findIinaCli(this.opts.cliPath);
    if (!this.cli) {
      throw new Error(
        'IINA not found. Install it from iina.io, or set NFL_PLAYER=mpv to use mpv.',
      );
    }
  }

  async load(path: string, opts: LoadOptions = {}): Promise<void> {
    if (!this.cli) await this.start();

    /**
     * Launch first, then connect.
     *
     * The socket only exists while IINA has a file open — it is created by IINA's own
     * mpv instance at startup, so there is nothing to connect to beforehand.
     */
    const args = ['--no-stdin', '--keep-running'];
    if (opts.startAt !== undefined && opts.startAt > 0) {
      // `--mpv-` is the documented passthrough for ordinary mpv options.
      args.push(`--mpv-start=${Math.floor(opts.startAt)}`);
    }
    args.push(path);

    spawn(this.cli!, args, { stdio: 'ignore', detached: true }).unref();

    // IINA has to launch, open the file and create the socket. Poll rather than
    // guessing a fixed delay, because a cold start with a 60 GB file is not quick.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const ipc = new MpvIpc(this.socketPath);
        await ipc.connect();
        this.ipc = ipc;

        ipc.on('property-change', (msg: MpvPropertyChange) => {
          this.observers.get(msg.id)?.cb(msg.data);
        });
        // The socket closing means IINA closed the file — the same signal a bare mpv
        // process exiting gives us, so the app can save progress and refresh.
        ipc.on('close', () => {
          this.ipc = null;
          this.opts.onExit?.();
        });

        /**
         * Wait for the FILE to be open, not just the socket.
         *
         * The socket appears when IINA's mpv starts, which can be before it has opened
         * anything. Reading properties at that moment returns a blank player — 0x0,
         * no codec, no audio device — and the status block reported that as fact.
         */
        await this.waitForFile();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    throw new IinaNotConfiguredError(this.socketPath);
  }

  /** Poll until mpv reports real dimensions, meaning the file is genuinely open. */
  private async waitForFile(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const w = await this.ipc?.getProperty<number>('width');
        if (w && w > 0) return;
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Fall through rather than throwing: playback is fine, only the report suffers.
  }

  private require(): MpvIpc {
    if (!this.ipc) throw new MpvIpcError('not connected to IINA');
    return this.ipc;
  }

  play(): void {
    void this.require().setProperty('pause', false);
  }
  pause(): void {
    void this.require().setProperty('pause', true);
  }
  async togglePause(): Promise<boolean> {
    const paused = await this.require().getProperty<boolean>('pause');
    await this.require().setProperty('pause', !paused);
    return !paused;
  }
  seek(sec: number, mode: SeekMode): void {
    void this.require().command(['seek', sec, mode]);
  }
  async setTrack(type: TrackType, id: TrackId): Promise<void> {
    const prop = type === 'audio' ? 'aid' : type === 'sub' ? 'sid' : 'vid';
    await this.require().setProperty(prop, id);
  }
  async setVolume(volume: number): Promise<void> {
    await this.require().setProperty('volume', Math.max(0, Math.min(150, volume)));
  }
  async setMute(mute: boolean): Promise<void> {
    await this.require().setProperty('mute', mute);
  }
  async setSpeed(speed: number): Promise<void> {
    await this.require().setProperty('speed', Math.max(0.25, Math.min(4, speed)));
  }

  async get<K extends MpvProp>(prop: K): Promise<MpvPropertyMap[K]> {
    return this.require().getProperty<MpvPropertyMap[K]>(prop);
  }

  observe<K extends MpvProp>(prop: K, cb: (value: MpvPropertyMap[K]) => void): Unsub {
    const ipc = this.require();
    const observeId = this.nextObserveId++;
    this.observers.set(observeId, { observeId, cb: cb as (v: unknown) => void });
    void ipc.observeProperty(observeId, prop).catch(() => {
      this.observers.delete(observeId);
    });
    return () => {
      this.observers.delete(observeId);
      void ipc.unobserveProperty(observeId).catch(() => {});
    };
  }

  async screenshotAt(): Promise<string> {
    // Thumbnails run a separate short-lived mpv; driving IINA's window for them would
    // interrupt what the viewer is watching.
    throw new Error('screenshotAt is not supported by the IINA engine');
  }

  async dispose(): Promise<void> {
    try {
      // Ask IINA to close the file rather than killing the app — it may be the user's
      // own player with other windows open.
      await this.ipc?.command(['quit']);
    } catch {
      /* already gone */
    }
    this.ipc?.close();
    this.ipc = null;
  }
}
