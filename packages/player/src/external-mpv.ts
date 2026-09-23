/**
 * Tier 0 PlaybackEngine: one long-lived external mpv process, driven over JSON IPC.
 *
 * "Long-lived" is the important word. mpv is started once per session with
 * --idle=yes and fed files via `loadfile`. Spawning per playback costs roughly
 * 800ms of process + GPU context setup every time, which is exactly the moment the
 * user is watching for a response. See ARCHITECTURE.md §9.2.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { playerCacheDir } from './cache-dir.js';
import { MpvIpc, MpvIpcError, type MpvPropertyChange } from './mpv-ipc.js';
import { buildMpvArgs, type MpvConfigOptions } from './mpv-config.js';
import {
  higherTier,
  lowerTier,
  motionToArgs,
  MOTION_OFF,
  MOTION_OPTIONS,
  QUALITY_TIERS,
  tierDelta,
  tierToArgs,
  type QualityTier,
} from './quality.js';
import {
  detectCapabilities,
  recordObservedCeiling,
  suggestTierForContent,
  supportedGpuContexts,
  supportedOptions,
  type MachineCapabilities,
} from './capabilities.js';
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

export type ExternalMpvOptions = {
  /** Path to the mpv binary. */
  mpvPath?: string;
  headless?: boolean;
  hdrPassthrough?: boolean;
  /**
   * Shader cache location. Defaults to a stable per-user directory — it must NOT
   * live in the per-instance temp dir, or the cache is thrown away on every quit
   * and startup stays slow forever.
   */
  shaderCacheDir?: string;
  maxCacheBytes?: string;
  audioChannels?: string;
  ownControls?: boolean;
  targetPeak?: number;
  gpuContext?: string;
  raw?: string[];
  nativeMetal?: boolean;
  ao?: string;
  /**
   * Quality tier, or 'auto' to probe the machine and let the watchdog settle it.
   * Defaults to 'auto'.
   */
  quality?: QualityTier | 'auto';
  /**
   * Motion interpolation (judder reduction). Defaults on only for 'reference'.
   * Costs ~5x render load on a high-refresh display, which is why the watchdog
   * disables this before it touches picture quality.
   */
  motionInterpolation?: boolean;
  /**
   * Allow the watchdog to drop a tier when frames are being dropped. On by default:
   * a stutter-free picture at 'high' beats a stuttering one at 'reference'.
   */
  adaptiveQuality?: boolean;
  onQualityChange?: (tier: QualityTier, reason: string) => void;
  extraArgs?: string[];
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

type Observer = {
  observeId: number;
  prop: string;
  cb: (value: unknown) => void;
};

export class ExternalMpvEngine implements PlaybackEngine {
  private process?: ChildProcess;
  private ipc?: MpvIpc;
  private socketDir?: string;
  private readonly observers = new Map<number, Observer>();
  private nextObserveId = 1;
  private disposed = false;
  private mpvPath: string;
  private tier: QualityTier = 'high';
  private motion = false;
  /** What the hardware is rated for, independent of any demotion. */
  private hardwareCeiling: QualityTier | null = null;
  /** Metal path when this build offers it. See start(). */
  private resolvedGpuContext: string | undefined;
  /** The flags mpv was actually launched with, for reporting. */
  private launchArgs: string[] = [];
  /** Set when --metal was asked for but this mpv build has no cocoa-cb context. */
  private nativeMetalUnavailable = false;
  private supported?: Set<string>;
  private capabilities?: MachineCapabilities;
  private watchdogStop?: () => void;

  constructor(private readonly opts: ExternalMpvOptions = {}) {
    this.mpvPath = opts.mpvPath ?? 'mpv';
  }

  /** Spawn mpv and connect. Safe to call once; subsequent calls are a no-op. */
  async start(): Promise<void> {
    if (this.ipc) return;

    // A private directory per instance avoids collisions between concurrent engines
    // (the main player and the thumbnailer, for example) and makes cleanup trivial.
    this.socketDir = await mkdtemp(join(tmpdir(), 'nfl-mpv-'));
    const socketPath = join(this.socketDir, 'ipc.sock');

    const shaderCacheDir =
      this.opts.shaderCacheDir ?? join(playerCacheDir(), 'mpv-shaders');
    if (!this.opts.headless) {
      await mkdir(shaderCacheDir, { recursive: true }).catch(() => {});
    }

    // Resolve the tier before spawning. 'auto' probes the machine; the watchdog
    // corrects the guess once real frame-timing data exists.
    this.supported = await supportedOptions(this.mpvPath);

    /**
     * Prefer mpv's Metal path on macOS.
     *
     * OpenGL on macOS is deprecated and capped at SDR, so HDR passthrough is signalled
     * and SDR comes out — measurably dimmer, exactly as if tone-mapping were still on.
     * Only `macvk` (Vulkan via MoltenVK) can negotiate EDR headroom with the display.
     *
     * Probed, never assumed: the option filter checks NAMES, and `gpu-context` is valid
     * everywhere, but an unavailable VALUE is a FATAL error — mpv exits and there is no
     * video at all. An explicit choice always wins.
     */
    if (!this.opts.headless) {
      const contexts = await supportedGpuContexts(this.mpvPath);

      /**
       * Verify the native Metal path exists before taking it.
       *
       * mpv has been moving away from `cocoa-cb` toward `macvk`, so it may simply not
       * be in a given build. An unavailable gpu-context is a FATAL error — mpv exits
       * and there is no video at all — and the option filter cannot catch it, because
       * it validates names and `gpu-context` is a valid name everywhere.
       */
      if (this.opts.nativeMetal && !contexts.has('cocoa-cb')) {
        this.nativeMetalUnavailable = true;
      } else if (!this.opts.gpuContext && !this.opts.nativeMetal && contexts.has('macvk')) {
        this.resolvedGpuContext = 'macvk';
      }
    }
    if (!this.opts.headless) {
      const requested = this.opts.quality ?? 'auto';
      if (requested === 'auto') {
        this.capabilities = await detectCapabilities();
        /**
         * Always start at what the hardware warrants, never at a remembered demotion.
         *
         * Starting from a persisted ceiling seemed prudent — avoid an opening stutter —
         * but what it actually did was begin every session at the worst moment the
         * machine ever had. The watchdog adapts within about ten seconds, so a brief
         * stutter costs far less than permanently running two tiers low.
         */
        this.hardwareCeiling = this.capabilities.suggestedTier;
        this.tier = this.capabilities.suggestedTier;
      } else {
        // An explicit request is the user's call; never adapt above it either.
        this.tier = requested;
        this.hardwareCeiling = requested;
      }
      // Default OFF at every tier. Interpolation reduces judder; it adds no detail.
      // Whether you want it is a preference, and it is the single most expensive
      // setting mpv offers — so it is opt-in via --motion.
      this.motion = this.opts.motionInterpolation ?? false;
    }

    const config: MpvConfigOptions = {
      socketPath,
      headless: this.opts.headless,
      hdrPassthrough: this.opts.hdrPassthrough,
      shaderCacheDir,
      maxCacheBytes: this.opts.maxCacheBytes,
      audioChannels: this.opts.audioChannels,
      ownControls: this.opts.ownControls,
      targetPeak: this.opts.targetPeak,
      gpuContext: this.opts.gpuContext ?? this.resolvedGpuContext,
      raw: this.opts.raw,
      nativeMetal: this.opts.nativeMetal && !this.nativeMetalUnavailable,
      ao: this.opts.ao,
      supported: this.supported,
      qualityArgs: this.opts.headless
        ? []
        : [...tierToArgs(this.tier, this.supported), ...motionToArgs(this.motion, this.supported)],
      extra: this.opts.extraArgs,
    };

    this.launchArgs = buildMpvArgs(config);
    this.process = spawn(this.mpvPath, this.launchArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    this.process.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    this.process.on('exit', (code, signal) => {
      this.opts.onExit?.(code, signal);
    });

    const spawnFailure = new Promise<never>((_, reject) => {
      this.process!.once('error', (err) =>
        reject(new MpvIpcError(`failed to spawn mpv (${this.mpvPath}): ${err.message}`)),
      );
      this.process!.once('exit', (code) =>
        reject(
          new MpvIpcError(
            `mpv exited before IPC was ready (code ${code}).${stderr ? ` stderr: ${stderr.trim()}` : ''}`,
          ),
        ),
      );
    });

    this.ipc = new MpvIpc(socketPath);
    // Race the connect against early process death, so a bad flag surfaces as a clear
    // error instead of a 10-second connect timeout.
    await Promise.race([this.ipc.connect(), spawnFailure]);

    this.ipc.on('property-change', (msg: MpvPropertyChange) => {
      // mpv omits `data` entirely when a property becomes unavailable — as a file
        // unloads, time-pos does exactly that. Callers are typed for `null`, and an
        // `undefined` slipping through reached state/ as a missing position.
        this.observers.get(msg.id)?.cb(msg.data ?? null);
    });

    this.startWatchdog();
  }

  private requireIpc(): MpvIpc {
    if (!this.ipc) throw new MpvIpcError('engine not started — call start() first');
    return this.ipc;
  }

  async load(path: string, opts: LoadOptions = {}): Promise<void> {
    const ipc = this.requireIpc();

    // loadfile options are passed as a single comma-separated string.
    const fileOptions: string[] = [];
    if (opts.startAt && opts.startAt > 0) fileOptions.push(`start=${opts.startAt}`);
    if (opts.audioTrack !== undefined) fileOptions.push(`aid=${opts.audioTrack}`);
    if (opts.subtitleTrack !== undefined) fileOptions.push(`sid=${opts.subtitleTrack}`);

    const cmd: unknown[] = ['loadfile', path, 'replace'];
    if (fileOptions.length) cmd.push(0, fileOptions.join(','));

    await ipc.command(cmd);

    // loadfile returns as soon as the request is accepted, not when the file is ready.
    // Wait for the file to actually open so callers can read duration immediately.
    await this.waitForEvent('file-loaded', 30_000);

    // Now that the resolution is known, adjust the opening tier for the workload.
    // Only downward, and only when the tier was auto-chosen — an explicit request
    // is the user's call to make.
    if ((this.opts.quality ?? 'auto') === 'auto' && !this.opts.headless) {
      const height = await this.get('height').catch(() => null);
      const cores = this.capabilities?.gpuCores ?? null;

      // Cap the promotion ceiling for this content too: 4K is four times the pixels of
      // 1080p, so a machine rated for Reference at 1080p should not climb there here.
      this.hardwareCeiling = suggestTierForContent(
        this.hardwareCeiling ?? this.tier,
        height,
        cores,
      );

      const adjusted = suggestTierForContent(this.tier, height, cores);
      if (adjusted !== this.tier) {
        await this.setQualityTier(
          adjusted,
          `${height}p content — starting at ${QUALITY_TIERS[adjusted].label}`,
        );
      }
    }
  }

  private waitForEvent(eventName: string, timeoutMs: number): Promise<void> {
    const ipc = this.requireIpc();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new MpvIpcError(`timed out waiting for mpv event "${eventName}"`));
      }, timeoutMs);

      const onEvent = (msg: { event: string }) => {
        if (msg.event === eventName) {
          cleanup();
          resolve();
        } else if (msg.event === 'end-file') {
          const reason = (msg as Record<string, unknown>).reason;
          if (reason === 'error') {
            cleanup();
            reject(new MpvIpcError(`mpv failed to open the file (${String(reason)})`));
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        ipc.off('event', onEvent);
      };

      ipc.on('event', onEvent);
    });
  }

  play(): void {
    this.ipc?.send(['set_property', 'pause', false]);
  }

  pause(): void {
    this.ipc?.send(['set_property', 'pause', true]);
  }

  async togglePause(): Promise<boolean> {
    const ipc = this.requireIpc();
    const paused = await ipc.getProperty<boolean>('pause');
    await ipc.setProperty('pause', !paused);
    return !paused;
  }

  /** Fire-and-forget: scrubbing generates a lot of these and a round trip adds lag. */
  seek(sec: number, mode: SeekMode): void {
    this.ipc?.send(['seek', sec, mode === 'absolute' ? 'absolute' : 'relative']);
  }

  async setTrack(type: TrackType, id: TrackId): Promise<void> {
    const prop = type === 'audio' ? 'aid' : 'sid';
    await this.requireIpc().setProperty(prop, id);
  }

  async setVolume(volume: number): Promise<void> {
    await this.requireIpc().setProperty('volume', Math.max(0, Math.min(100, volume)));
  }

  async setMute(mute: boolean): Promise<void> {
    await this.requireIpc().setProperty('mute', mute);
  }

  /** Toggle mpv's window ontop flag — used to pull it forward on app activation. */
  async setOntop(ontop: boolean): Promise<void> {
    await this.requireIpc().setProperty('ontop', ontop);
  }

  /** Playback speed. mpv clamps extremes itself; keep it in a sane UI range. */
  async setSpeed(speed: number): Promise<void> {
    await this.requireIpc().setProperty('speed', Math.max(0.25, Math.min(4, speed)));
  }

  get<K extends MpvProp>(prop: K): Promise<MpvPropertyMap[K]> {
    return this.requireIpc().getProperty<MpvPropertyMap[K]>(prop);
  }

  observe<K extends MpvProp>(prop: K, cb: (value: MpvPropertyMap[K]) => void): Unsub {
    const ipc = this.requireIpc();
    const observeId = this.nextObserveId++;
    this.observers.set(observeId, { observeId, prop, cb: cb as (v: unknown) => void });
    void ipc.observeProperty(observeId, prop).catch(() => {
      this.observers.delete(observeId);
    });

    return () => {
      this.observers.delete(observeId);
      void ipc.unobserveProperty(observeId).catch(() => {});
    };
  }

  /**
   * Tier 0 scrub preview: a throwaway mpv that keyframe-seeks and writes one frame.
   *
   * Deliberately NOT done on the playing instance — screenshotting there would fight
   * with playback. Milestone 6 replaces this with the thumbfast pattern (a persistent
   * hidden instance), which is the same idea without per-frame process startup.
   */
  async screenshotAt(sec: number, outPath: string): Promise<string> {
    const path = await this.get('path');
    if (!path) throw new MpvIpcError('no file loaded');

    await exec(this.mpvPath, [
      path,
      '--no-config',
      '--no-terminal',
      '--really-quiet',
      `--start=${sec}`,
      '--frames=1',
      '--no-audio',
      '--no-sub',
      '--hr-seek=no', // keyframe seek: approximate, but fast on an 80 GB file
      '--vf=scale=320:-2',
      `--o=${outPath}`,
    ]);
    return outPath;
  }

  /**
   * Video-relevant flags this process was launched with.
   *
   * mpv can only report what was ASKED for, not what it resolved `auto` to, so the
   * only honest thing to show is what we passed. Without this there is no way to tell
   * whether an experiment via NFL_MPV_ARGS actually reached mpv — the log looked
   * identical either way.
   */
  /** True when the native Metal path was requested but is not in this mpv build. */
  get metalUnavailable(): boolean {
    return this.nativeMetalUnavailable;
  }

  get videoFlags(): string[] {
    return this.launchArgs.filter((a) =>
      /^--(gpu-|target-|tone-|cocoa-|vo=|hwdec|icc-)/.test(a),
    );
  }

  get qualityTier(): QualityTier {
    return this.tier;
  }

  get machineCapabilities(): MachineCapabilities | undefined {
    return this.capabilities;
  }

  /** Apply a tier live. gpu-next accepts these at runtime, so no restart is needed. */
  async setQualityTier(next: QualityTier, reason = 'manual'): Promise<void> {
    if (next === this.tier) return;
    const delta = tierDelta(this.tier, next);
    const ipc = this.requireIpc();

    for (const [name, value] of Object.entries(delta)) {
      if (this.supported && !this.supported.has(name)) continue;
      // One failed option must not abort the rest of the tier change.
      await ipc.setProperty(name, value).catch(() => {});
    }
    this.tier = next;
    this.opts.onQualityChange?.(next, reason);
    // Remember it, so the next launch does not repeat the same stutter-then-fix cycle.
    if (reason !== 'manual') void recordObservedCeiling(next).catch(() => {});
  }

  get motionInterpolation(): boolean {
    return this.motion;
  }

  /** Toggle motion interpolation live. The watchdog's first lever. */
  async setMotionInterpolation(enabled: boolean, reason = 'manual'): Promise<void> {
    if (enabled === this.motion) return;
    const ipc = this.requireIpc();
    const opts = enabled ? MOTION_OPTIONS : MOTION_OFF;
    for (const [name, value] of Object.entries(opts)) {
      if (this.supported && !this.supported.has(name)) continue;
      await ipc.setProperty(name, value).catch(() => {});
    }
    this.motion = enabled;
    this.opts.onQualityChange?.(this.tier, reason);
  }

  /**
   * Frame-drop watchdog.
   *
   * Samples on a fixed interval rather than reacting to property-change events.
   * That distinction is the whole bug in the first version: `observe_property` fires
   * on change, so drops arriving one at a time produced a stream of delta=1 callbacks
   * and a threshold of "more than 2 per callback" could never be reached. Measuring a
   * RATE requires a clock, not an event.
   *
   * Escalation is ordered by what it costs the viewer:
   *   1. disable motion interpolation — removes ~5x render load on a high-refresh
   *      panel and costs no image detail, only judder smoothing
   *   2. demote the tier — now we are giving up actual picture quality
   *
   * It also climbs back. Demotion-only was a ratchet: one bad sample — during a scan,
   * with other apps loaded, or on an unusually heavy scene — pinned the machine at a
   * lower tier permanently, because the ceiling was persisted and never revisited. A
   * 16-core M1 Pro ended up running at 'Efficient', the lowest setting there is.
   *
   * Promotion is deliberately slower than demotion and backs off further after each
   * demotion, so it settles rather than oscillating. It never climbs above the tier
   * the hardware and content warrant.
   */
  private startWatchdog(): void {
    if (this.opts.adaptiveQuality === false || this.opts.headless) return;

    /**
     * Sample often, but judge over a WINDOW.
     *
     * Judging each 2s sample alone made the threshold finer than the measurement: at
     * 24fps a 2s sample is 48 frames, so ONE dropped frame reads as 2.1% — already
     * over the 0.8% limit. A single dropped frame is imperceptible and completely
     * normal; demoting for it gave up real picture quality for nothing.
     *
     * Ten seconds of samples is 240 frames, so one drop reads as 0.4% and the limit
     * means roughly two drops in ten seconds — a rate you can actually see.
     */
    const SAMPLE_MS = 2000;
    const WINDOW_SAMPLES = 5; // 10s
    /** Fraction of frames dropped that counts as a real problem. */
    const DROP_RATE_LIMIT = 0.008; // 0.8% of frames
    const recent: number[] = [];
    let lastDrops = 0;
    let graceUntil = Date.now() + 5000; // startup and first-seek burst

    /** Uninterrupted clean time, reset by any meaningful drop. */
    let cleanMs = 0;
    /** Rises after each demotion so a marginal machine stops trying. */
    let promoteAfterMs = 45_000;
    /**
     * Read the ceiling LIVE, never captured once.
     *
     * The watchdog starts before a file is loaded, but the content adjustment that
     * narrows the ceiling for 4K only happens after `file-loaded` — the resolution is
     * not known before then. Capturing it here meant a 16-core machine kept the
     * hardware rating of Reference and promoted into it on 2160p content, which is
     * precisely the tier measured dropping ~6% of frames.
     */
    const currentCeiling = () => this.hardwareCeiling ?? this.tier;

    const timer = setInterval(() => {
      if (this.disposed || !this.ipc) return;

      void (async () => {
        try {
          const [drops, paused, fpsRaw] = await Promise.all([
            this.get('frame-drop-count'),
            this.get('pause'),
            this.get('container-fps'),
          ]);

          const total = Number(drops ?? 0);
          const delta = Math.max(0, total - lastDrops);
          lastDrops = total;

          if (paused || Date.now() < graceUntil) return;

          const fps = Number(fpsRaw ?? 24) || 24;

          recent.push(delta);
          if (recent.length > WINDOW_SAMPLES) recent.shift();
          // Wait for a full window rather than judging a partial one, which would
          // reintroduce the same resolution problem at a smaller scale.
          if (recent.length < WINDOW_SAMPLES) return;

          const dropped = recent.reduce((a, b) => a + b, 0);
          const expectedFrames = fps * ((SAMPLE_MS * WINDOW_SAMPLES) / 1000);
          const rate = dropped / expectedFrames;

          if (rate > DROP_RATE_LIMIT) {
            // The window has already averaged 10s of playback, so a second
            // confirmation would only add another 10s of visible stutter.
            cleanMs = 0;
            recent.length = 0;
            graceUntil = Date.now() + 10_000;
            // Each demotion makes the next attempt to climb back more patient.
            promoteAfterMs = Math.min(promoteAfterMs * 2, 10 * 60_000);

            const pct = (rate * 100).toFixed(1);
            if (this.motion) {
              void this.setMotionInterpolation(
                false,
                `${pct}% frames dropped — disabling motion interpolation`,
              );
              return;
            }
            const next = lowerTier(this.tier);
            if (next) {
              void this.setQualityTier(
                next,
                `${pct}% frames dropped — stepping down to ${QUALITY_TIERS[next].label}`,
              );
            }
          } else {
            cleanMs += SAMPLE_MS;

            if (cleanMs >= promoteAfterMs) {
              cleanMs = 0;
              const up = higherTier(this.tier, currentCeiling());
              if (up) {
                void this.setQualityTier(
                  up,
                  `steady for ${Math.round(promoteAfterMs / 1000)}s — back up to ${QUALITY_TIERS[up].label}`,
                );
                graceUntil = Date.now() + 8000;
              }
            }
          }
        } catch {
          /* mpv went away; dispose will clean up */
        }
      })();
    }, SAMPLE_MS);

    this.watchdogStop = () => clearInterval(timer);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watchdogStop?.();

    try {
      this.ipc?.send(['quit']);
    } catch {
      /* already gone */
    }
    this.ipc?.close();

    if (this.process && this.process.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        this.process!.once('exit', () => resolve());
      });
      const timer = setTimeout(() => this.process?.kill('SIGKILL'), 2000);
      this.process.kill('SIGTERM');
      await exited;
      clearTimeout(timer);
    }

    if (this.socketDir) {
      await rm(this.socketDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
