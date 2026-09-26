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
 * Advanced → "Additional mpv options", which is a list of option/value pairs — as the
 * option `input-ipc-server` with the value `/tmp/nerdflix-iina.sock`.
 *
 * This is the same thing SVP users do. Without it we can launch films but cannot track
 * progress, so the engine refuses to start rather than silently losing watch history.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { basename } from 'node:path';
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
  /** How long to wait for IINA to open the file and answer for it. Tests shorten it. */
  loadTimeoutMs?: number;
};

/**
 * IINA opened the film, but no player on the socket would say it was playing it.
 *
 * Refused rather than tolerated: attaching to another player would record THAT player's
 * position as this film's progress, and quit the wrong window when the next film starts.
 */
export class IinaOtherPlayerError extends Error {
  constructor() {
    super(
      'The film opened in IINA, but Nerdflix could not reach the IINA window playing it, ' +
        'so its progress will not be saved. Quit IINA (⌘Q) and press Play again.',
    );
    this.name = 'IinaOtherPlayerError';
  }
}

/**
 * Is the file a player reports the one we launched?
 *
 * Compared composed, because a name read off a macOS disk can come back decomposed
 * ("é" as "e" + an accent), and tolerant of a file:// URL, which IINA may hand mpv.
 */
export function isSameMedia(reported: unknown, launched: string): boolean {
  if (typeof reported !== 'string' || reported === '') return false;
  const norm = (p: string) => {
    let s = p;
    if (s.startsWith('file://')) {
      try {
        s = decodeURIComponent(new URL(s).pathname);
      } catch {
        /* keep as given */
      }
    }
    return s.normalize('NFC');
  };
  const a = norm(reported);
  const b = norm(launched);
  return a === b || basename(a) === basename(b);
}

/**
 * How long a connected player may show NO file before it counts as someone else's.
 *
 * Every IINA program binds the same socket path, and `iina-cli` starts a new one per
 * film while the last one — its window closed — can still be running, idle, holding
 * the path. Connecting right after launch reaches THAT player first. A new IINA names
 * its file within moments of creating the socket; a leftover never does.
 */
const STRANGER_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve once `pid` no longer exists, or after `timeoutMs` — never throws. */
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0: existence check only, nothing is sent
    } catch {
      return;
    }
    await sleep(100);
  }
}

export class IinaNotConfiguredError extends Error {
  constructor(socketPath: string) {
    super(
      `IINA is not exposing an IPC socket at ${socketPath}.\n\n` +
        `Open IINA → Settings → Advanced, tick "Enable advanced settings", and under\n` +
        `"Additional mpv options" press + and add:\n\n` +
        `    option  input-ipc-server\n` +
        `    value   ${socketPath}\n\n` +
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
  /** The IINA process playing our film — libmpv runs inside it, so mpv's `pid` is IINA's. */
  private playerPid: number | null = null;

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
    /**
     * `resume-playback=no`: this launch plays exactly what Nerdflix asks for.
     *
     * IINA remembers each file's last position and tracks (its "watch later" files)
     * and applies them OVER the options it was launched with. Measured on IINA 1.4.4:
     * with a remembered commentary, `--mpv-aid=1` still played the commentary; with a
     * remembered position of 20s, a launch asking for no start position began at 20s,
     * so "Play from beginning" could resume mid-film. Nerdflix keeps its own position and
     * track choices in state/, so IINA's copy only ever contradicts them. Launched from
     * Finder, IINA still remembers as it always did.
     */
    const args = ['--no-stdin', '--keep-running', '--mpv-resume-playback=no'];
    if (opts.startAt !== undefined && opts.startAt > 0) {
      // `--mpv-` is the documented passthrough for ordinary mpv options.
      args.push(`--mpv-start=${Math.floor(opts.startAt)}`);
    }
    /**
     * Track selection goes through the same passthrough.
     *
     * It has to be set at LAUNCH rather than over IPC after the fact: switching audio
     * a second into playback is audible, and IINA has already opened the default
     * track's device by then. Unset subtitles stay unset, so IINA's preferences apply.
     */
    if (opts.audioTrack !== undefined) args.push(`--mpv-aid=${opts.audioTrack}`);
    if (opts.subtitleTrack !== undefined) args.push(`--mpv-sid=${opts.subtitleTrack}`);
    args.push(path);

    spawn(this.cli!, args, { stdio: 'ignore', detached: true }).unref();

    /*
     * IINA has to launch, open the file and create the socket. Poll rather than guess,
     * because a cold start with a 60 GB file on a spinning disk is not quick.
     *
     * And CONFIRM who answered. The socket path is shared by every IINA program, and the
     * previous film's IINA may still hold it — idle, window closed. Attaching to it
     * reported "0x0, SDR, software decode, audio device did not open" for real HDR
     * remuxes, recorded no progress for the film actually playing, and quit the wrong
     * player when the next film started. A player that is not showing our file is
     * dropped, and the path asked again until the new IINA has claimed it.
     */
    const deadline = Date.now() + (this.opts.loadTimeoutMs ?? 30_000);
    let reachedAnother = false;
    while (Date.now() < deadline) {
      let ipc: MpvIpc | null = null;
      try {
        ipc = new MpvIpc(this.socketPath);
        await ipc.connect(Math.max(250, Math.min(2_000, deadline - Date.now())));
        if ((await this.confirmFile(ipc, path, deadline)) === 'ours') {
          this.attach(ipc);
          return;
        }
        reachedAnother = true;
      } catch {
        /* no socket yet — IINA is still starting */
      }
      ipc?.close();
      await sleep(300);
    }

    throw reachedAnother ? new IinaOtherPlayerError() : new IinaNotConfiguredError(this.socketPath);
  }

  /**
   * Is this player showing the file we launched — and has it opened it?
   *
   * Waits for real dimensions, not just the name: a player that has only started to
   * load returns a blank picture (0x0, no codec, no audio device), and the status block
   * once printed exactly that as fact. A player that is ours but slow to open is still
   * ours when the deadline arrives; playback is fine, only the report may be early.
   */
  private async confirmFile(ipc: MpvIpc, path: string, deadline: number): Promise<'ours' | 'other'> {
    const connectedAt = Date.now();
    let ours = false;
    while (Date.now() < deadline) {
      const reported = await ipc.getProperty<string>('path').catch(() => null);
      if (typeof reported === 'string' && reported !== '') {
        if (!isSameMedia(reported, path)) return 'other';
        ours = true;
        const width = await ipc.getProperty<number>('width').catch(() => 0);
        if (width && width > 0) return 'ours';
      } else if (Date.now() - connectedAt > STRANGER_MS) {
        return 'other';
      }
      await sleep(200);
    }
    return ours ? 'ours' : 'other';
  }

  /** Take over a confirmed player: forward its events, and notice when it is done. */
  private attach(ipc: MpvIpc): void {
    this.ipc = ipc;
    void ipc
      .getProperty<number>('pid')
      .then((pid) => {
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) this.playerPid = pid;
      })
      .catch(() => {});

    ipc.on('property-change', (msg: MpvPropertyChange) => {
      // mpv omits `data` entirely when a property becomes unavailable — as a file
      // unloads, time-pos does exactly that. Callers are typed for `null`, and an
      // `undefined` slipping through reached state/ as a missing position.
      this.observers.get(msg.id)?.cb(msg.data ?? null);
    });
    // The socket closing means IINA closed the file — the same signal a bare mpv
    // process exiting gives us, so the app can save progress and refresh.
    ipc.on('close', () => {
      this.ipc = null;
      this.opts.onExit?.();
    });

    /*
     * Closing IINA's window does NOT close the socket: IINA keeps running, idle, still
     * holding the path — the leftover the next film then reached first, one more per
     * film watched. When our player has had no file for a moment, ask it to quit, which
     * ends that IINA and closes the socket (so `onExit` fires, as for bare mpv). The
     * delay is so a momentary gap between files is not mistaken for a closed window.
     */
    let idleTimer: NodeJS.Timeout | undefined;
    this.observe('idle-active', (idle) => {
      clearTimeout(idleTimer);
      if (idle !== true) return;
      idleTimer = setTimeout(() => {
        if (this.ipc === ipc) void ipc.command(['quit']).catch(() => {});
      }, 1_500);
    });
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

    /*
     * And wait until that IINA has actually gone, before the next film is launched —
     * bare mpv's dispose waits the same way. An IINA that is still shutting down can
     * still answer on the socket, so the next film's connection could reach it instead
     * of the new player; once it has exited it cannot. (It leaves its socket FILE
     * behind, dead: connecting to that fails at once and is simply retried.)
     */
    const pid = this.playerPid;
    this.playerPid = null;
    if (pid !== null) await waitForExit(pid, 5_000);
  }
}
