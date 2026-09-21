/**
 * Playback.
 *
 * mpv plays in its own window with its own controls. This is a deliberate choice,
 * not a shortcut.
 *
 * The alternative — a transparent Electron overlay floating over a borderless mpv
 * window — was built and abandoned. Two windows in two processes cannot be kept in
 * agreement on macOS: their sizes drift (different unit systems, mpv resizing itself
 * to the video's aspect), clicking the video focuses mpv so our app backgrounds while
 * an always-on-top overlay stays pinned over whatever you switch to, and hiding the
 * overlay to fix that traps it permanently because `activate` never fires for an app
 * the user never clicked. Each fix exposed the next problem.
 *
 * Netflix avoids all of it by having ONE window: video, letterbox and controls are
 * the same surface, so they cannot desync. Matching that needs libmpv rendering
 * inside Chromium's pipeline via a native addon. Until that is worth doing, mpv's own
 * controls are honest and reliable — and playback quality is identical either way.
 */

import { ipcMain } from 'electron';
import { MediaResolver, MetaStore, StateStore, type VolumeState } from '@nfl/core';
import {
  DEFAULT_IINA_SOCKET,
  ExternalMpvEngine,
  IinaEngine,
  findIinaCli,
  QUALITY_TIERS,
  formatStatus,
  readPlaybackStatus,
} from '@nfl/player';

type Engine = ExternalMpvEngine | IinaEngine;
let engine: Engine | null = null;

/**
 * Which player renders.
 *
 * IINA when it is installed, mpv otherwise. IINA's HDR is visibly better on Apple
 * silicon and five separate mpv configurations failed to close the gap — passthrough
 * signalling, `--target-peak`, MoltenVK via macvk, mpv's native cocoa-cb backend, and
 * explicit `--target-trc=pq --target-prim=bt.2020`. The difference is architectural:
 * IINA hosts libmpv and draws frames itself, so it owns the CAMetalLayer and can set
 * `wantsExtendedDynamicRangeContent` directly.
 *
 * Underneath, IINA IS mpv, so the same JSON IPC keeps resume tracking, status
 * reporting and quality adaptation. Only the rendering is delegated.
 *
 * NFL_PLAYER=mpv forces the old path; NFL_PLAYER=iina makes a missing IINA an error
 * rather than a silent fallback.
 */
async function chooseEngineKind(): Promise<'iina' | 'mpv'> {
  const forced = process.env.NFL_PLAYER;
  if (forced === 'mpv') return 'mpv';
  const cli = await findIinaCli();
  if (forced === 'iina') {
    if (!cli) throw new Error('NFL_PLAYER=iina but IINA is not installed (iina.io)');
    return 'iina';
  }
  return cli ? 'iina' : 'mpv';
}

type Deps = {
  store: MetaStore;
  state: StateStore;
  getStates: () => VolumeState[];
  onClosed?: () => void;
};

export function registerPlaybackIpc(deps: Deps): void {
  ipcMain.handle(
    'library:play',
    async (_e, id: string, versionIndex = 0, fromStart = false) => {
      const title = await deps.store.get(id);
      if (!title) throw new Error('Title not found');

      const resolver = new MediaResolver(deps.getStates());
      const availability = resolver.resolve(title, versionIndex);
      if (availability.status !== 'available') {
        throw new Error(
          availability.status === 'offline'
            ? `${availability.volumeLabel} isn't connected`
            : 'File not found',
        );
      }

      const progress = fromStart ? null : await deps.state.getProgress(id);
      const duration = availability.media.durationSec;
      const displayTitle = `${title.title}${title.year ? ` (${title.year})` : ''}`;

      // A fresh session per film. Reusing one idle instance saves ~250ms of startup
      // but inherits the previous window's fullscreen state and size, which is more
      // confusing than the delay is costly.
      if (engine) {
        await engine.dispose().catch(() => {});
        engine = null;
      }

      // Declared before either engine so onExit can clear it in both paths.
      let dropTimer: NodeJS.Timeout | undefined;

      const kind = await chooseEngineKind();

      if (kind === 'iina') {
        const iina = new IinaEngine({
          socketPath: process.env.NFL_IINA_SOCKET ?? DEFAULT_IINA_SOCKET,
          onExit: () => {
            clearInterval(dropTimer);
            engine = null;
            deps.onClosed?.();
          },
        });
        engine = iina;
        await iina.start();
        await iina.load(availability.absolutePath, { startAt: progress?.positionSec });
        iina.play();

        console.log(`\n▶ ${displayTitle}  \x1b[2m(IINA)\x1b[0m`);
        try {
          for (const line of formatStatus(await readPlaybackStatus(iina, { renderer: 'host' })))
            console.log(line);
        } catch {
          /* playback still works; only the report is missing */
        }

        iina.observe('time-pos', (pos) => {
          if (pos === null) return;
          void deps.state.setProgress(id, pos, duration, versionIndex);
        });

        return { ok: true };
      }

      engine = new ExternalMpvEngine({
        ownControls: true,
        /**
         * Assert the display's peak luminance when mpv's `auto` guesses low.
         *
         * An underestimate makes HDR look DIMMER than tone-mapped SDR, because the
         * highlights have nowhere to go. Set NFL_TARGET_PEAK to your panel's peak
         * (about 1600 for an XDR MacBook Pro) if HDR looks flat. Unset means mpv
         * negotiates it, which is right when the negotiation works.
         */
        targetPeak: process.env.NFL_TARGET_PEAK
          ? Number(process.env.NFL_TARGET_PEAK)
          : undefined,
        // NFL_GPU_CONTEXT=macvk forces mpv's Metal path. macOS OpenGL cannot do EDR,
        // so HDR silently comes out as SDR if the OpenGL context is selected.
        gpuContext: process.env.NFL_GPU_CONTEXT || undefined,
        // NFL_METAL=1 — mpv's native Swift/Metal backend instead of MoltenVK.
        nativeMetal: process.env.NFL_METAL === '1',
        // NFL_MPV_ARGS="--flag=a --flag=b" — raw passthrough, same lever as the CLI's
        // --mpv=, so a finding from `pnpm play` is directly usable in the app.
        raw: process.env.NFL_MPV_ARGS
          ? process.env.NFL_MPV_ARGS.split(/\s+/).filter(Boolean)
          : undefined,
        extraArgs: [
          /**
           * A large centred window rather than mpv's native fullscreen.
           *
           * Fullscreen hides the title bar, and with it the close button — leaving
           * `q` as the only way out, which is not discoverable. A normal window keeps
           * the macOS traffic lights, and the green button or `f` gives fullscreen
           * whenever it is wanted. Percentages so it lands correctly on any display.
           */
          '--autofit=92%x92%',
          '--geometry=50%:50%',

          /**
           * Kill the OSD bar — the seek/volume feedback strip, which is separate from
           * the OSC control bar. It draws using mpv's bundled symbol font and renders
           * as a white zigzag when that font does not resolve. The OSC below already
           * shows position and volume, so nothing is lost.
           */
          '--osd-bar=no',
          '--osd-level=1',

          '--cursor-autohide=1000',

          // The library's title, in both the OSC and the window title bar, instead of
          // the scene filename.
          `--force-media-title=${displayTitle}`,
          `--title=${displayTitle}`,
        ],
        // Quality now moves in both directions, so say when and why — otherwise a
        // demotion mid-film looks like the picture randomly changing.
        onQualityChange: (tier, reason) => {
          console.log(`  \x1b[36mquality → ${QUALITY_TIERS[tier].label}\x1b[0m \x1b[2m${reason}\x1b[0m`);
        },
        onExit: () => {
          clearInterval(dropTimer);
          engine = null;
          // Returning to browse should show the new resume position immediately.
          deps.onClosed?.();
        },
      });

      await engine.start();
      await engine.load(availability.absolutePath, { startAt: progress?.positionSec });
      engine.play();

      /**
       * Report to the terminal what is actually happening.
       *
       * `pnpm app` runs in a terminal, and until now printed nothing about playback —
       * so an HDR file being flattened to SDR, or hardware decode silently falling
       * back, was invisible. Every line here is read back from mpv, not from config.
       */
      void (async () => {
        try {
          const status = await readPlaybackStatus(engine!);
          console.log(`\n▶ ${displayTitle}`);
          for (const line of formatStatus(status)) console.log(line);
          // Say WHY the tier was chosen. 'balanced' on a 16-core machine looks like a
          // bug unless it is clear whether that is the content, the hardware, or a
          // measured ceiling from a previous session.
          const tier = engine!.qualityTier;
          const caps = engine!.machineCapabilities;
          const why =
            status.source.height >= 1400
              ? `${status.source.height}p on ${caps?.gpuCores ?? '?'} GPU cores`
              : `${caps?.gpuCores ?? '?'} GPU cores`;
          console.log(
            `  \x1b[2mquality: ${QUALITY_TIERS[tier].label} — ${why}\x1b[0m`,
          );
          // Show the video flags actually passed. mpv cannot report what it resolved
          // `auto` to, so this is the only way to confirm an experiment took effect.
          const flags = engine!.videoFlags;
          if (flags.length) console.log(`  \x1b[2mvideo: ${flags.join(' ')}\x1b[0m`);
        } catch {
          /* playback still works; only the report is missing */
        }
      })();

      // Frame drops, sampled over a window so one stray frame is not reported as 2%.
      let lastDrops = 0;
      let reported = 0;
      dropTimer = setInterval(() => {
        void (async () => {
          const total = Number((await engine?.get('frame-drop-count').catch(() => 0)) ?? 0);
          if (total > lastDrops) {
            lastDrops = total;
            // Only speak up when it crosses from "invisible" to "you would notice".
            if (total - reported >= 24) {
              reported = total;
              console.log(`  \x1b[33m${total} frames dropped so far\x1b[0m`);
            }
          }
        })();
      }, 5000);

      engine.observe('time-pos', (pos) => {
        if (pos === null) return;
        void deps.state.setProgress(id, pos, duration, versionIndex);
      });

      return { ok: true };
    },
  );

  ipcMain.handle('library:stop', async () => {
    await engine?.dispose().catch(() => {});
    engine = null;
  });
}

export async function disposePlayback(): Promise<void> {
  await engine?.dispose().catch(() => {});
  engine = null;
}
