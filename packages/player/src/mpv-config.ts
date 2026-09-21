/**
 * mpv launch configuration. See ARCHITECTURE.md §9.3.
 *
 * Every flag here is load-bearing; the comments say why so nobody trims them later.
 */

export type MpvConfigOptions = {
  socketPath: string;
  /** Headless: no window, no audio device. Used by tests and the thumbnailer. */
  headless?: boolean;
  /**
   * Let mpv draw its own on-screen controls and handle its own keys.
   *
   * Default false, for the `pnpm play` harness and any future embedded renderer where
   * we own the interface. The app sets it true: mpv owns playback entirely, which is
   * the settled design — see apps/desktop/src/main/library-ipc.ts for why.
   */
  ownControls?: boolean;
  /**
   * HDR passthrough to the display instead of tone-mapping to SDR.
   *
   * ON by default. It was off out of caution — MoltenVK colourspace hinting had
   * reported crashes and ProMotion at 120 Hz had vsync jitter — but neither appeared
   * in testing on Apple silicon, and the cost of the caution was severe: a Dolby
   * Vision remux on a 1600-nit XDR panel was being flattened to SDR, throwing away
   * exactly the thing the file exists for.
   *
   * Set false for a display that genuinely cannot show HDR, where tone-mapping to
   * bt.2390 gives a better result than letting the OS convert.
   */
  hdrPassthrough?: boolean;
  /**
   * Peak display luminance in nits, for HDR passthrough.
   *
   * mpv defaults to `auto`, which asks the windowing system. On macOS before 0.38 that
   * negotiation was weak, and an underestimate makes HDR look DIMMER than a
   * tone-mapped SDR image — the highlights have nowhere to go. An XDR panel sustains
   * about 1000 nits full-field and peaks near 1600.
   */
  targetPeak?: number;
  /**
   * Force a GPU context.
   *
   * On macOS this decides whether HDR can work at all. mpv's OpenGL context (`cocoa`)
   * cannot do EDR — OpenGL is deprecated on macOS and capped at SDR — so passthrough
   * is signalled and SDR comes out, which looks dim and desaturated exactly as if
   * tone-mapping were still on. Only the Metal path (`macvk`, Vulkan via MoltenVK)
   * can request extended dynamic range.
   *
   * Left unset by default because `auto` is usually right and a wrong value here means
   * no video at all. `--gpu-context=macvk` is the thing to try when HDR looks flat.
   */
  gpuContext?: string;
  /**
   * Render through mpv's NATIVE Metal backend instead of Vulkan-via-MoltenVK.
   *
   * On macOS, EDR is a property of the CAMetalLayer: an app sets
   * `wantsExtendedDynamicRangeContent` and supplies EDR metadata. Our default path is
   * gpu-next → Vulkan → MoltenVK → Metal, and MoltenVK gives no guarantee that those
   * EDR controls are plumbed through from Vulkan. That would explain HDR that has
   * correct colour but no headroom — accurate, and flat.
   *
   * `cocoa-cb` is mpv's own Swift/Metal backend, the closest thing to what IINA does.
   * It is NOT a Vulkan context, so selecting it also drops `--gpu-api=vulkan` and
   * `--vo=gpu-next`; passing those alongside is contradictory and silently wasted two
   * rounds of testing.
   */
  nativeMetal?: boolean;
  /**
   * Raw mpv flags, appended last so they override everything above.
   *
   * Deliberately NOT filtered against `--list-options`: these are for trying
   * platform-specific options this build may expose but a probe cannot confirm from
   * another OS. A bad flag here will stop mpv starting — that is the trade, and it is
   * the right one for an experiment lever.
   */
  raw?: string[];
  /**
   * Where libplacebo caches compiled shaders.
   *
   * This matters more than it looks. `--no-config` means mpv does not pick up a
   * default cache location, so every launch recompiles the gpu-next shader set
   * through MoltenVK — measured at ~5s of startup on Apple Silicon. With a cache
   * directory the second and later launches are a fraction of that.
   */
  shaderCacheDir?: string;
  /**
   * Demuxer readahead cap in bytes. This, not --demuxer-readahead-secs, is what
   * actually bounds the buffer: mpv keeps reading until the byte cap is reached.
   * At 57.7 Mb/s, 1 GiB buys ~149s of readahead and costs 1 GB of RAM. 512 MiB
   * (~74s) is ample for a local SSD; raise it for a congested network share.
   */
  maxCacheBytes?: string;
  /**
   * Quality options, already rendered to flags and already filtered against what
   * this mpv build supports. See quality.ts. Measured on Apple Silicon: with a warm
   * shader cache these cost ~0ms of startup, so there is no reason to hold back.
   */
  qualityArgs?: string[];
  /**
   * Output channel layout.
   *
   * Defaults to mpv's own `auto-safe`, which is known good: plain `mpv --no-config`
   * plays 5.1 correctly on the same hardware.
   *
   * `stereo` forces a downmix. Useful if a device claims multichannel support it
   * cannot actually render, but that turned out NOT to be the silent-playback cause
   * here — a pinned audio output was. Try changing the AO before forcing channels.
   */
  audioChannels?: 'auto-safe' | 'auto' | 'stereo' | string;
  /**
   * Force a specific audio output. Leave undefined so mpv's fallback chain works —
   * that chain is what recovers from a broken coreaudio device.
   */
  ao?: string;
  /** Extra flags, e.g. from user settings. */
  extra?: string[];
  /**
   * Options this mpv build understands. When given, EVERY flag is filtered against
   * it — including `extra`. mpv exits on an unrecognised option, and extras are
   * exactly where version-specific flags appear (`--focus-on` is 0.38+, while 0.37
   * has `--focus-on-open`), so leaving them unfiltered means a crash on some builds.
   */
  supported?: Set<string>;
};

export function buildMpvArgs(opts: MpvConfigOptions): string[] {
  const maxBytes = opts.maxCacheBytes ?? '512MiB';

  const args: string[] = [
    // --- control surface -------------------------------------------------------
    `--input-ipc-server=${opts.socketPath}`,
    // Stay alive with no file loaded. One long-lived process per session: spawning
    // per playback costs ~800ms and makes modal→playback feel broken.
    '--idle=yes',
    // Do not exit at end of file; we decide what happens next.
    '--keep-open=yes',
    ...(opts.ownControls
      ? [
          // mpv owns the interface: its OSC, its keys, its window chrome. The title
          // bar matters — it carries the close button, which is the only discoverable
          // way out of the player.
          '--osc=yes',
          '--input-default-bindings=yes',
          '--input-vo-keyboard=yes',
          '--border=yes',
        ]
      : [
          // Something else draws the controls, so mpv must draw and intercept nothing.
          '--osc=no',
          '--osd-bar=no',
          '--no-border',
          '--input-default-bindings=no',
          '--input-vo-keyboard=no',
        ]),
    // Do not read the user's ~/.config/mpv; our config must be reproducible.
    '--no-config',
    // Keep mpv off our stdin/stdout so the CLI can own the terminal.
    '--no-terminal',
    '--msg-level=all=warn',

    // --- streaming from SSD / USB / NAS ----------------------------------------
    // Not optional. At ~60 Mb/s a network hiccup without readahead is a visible stall.
    '--cache=yes',
    `--demuxer-max-bytes=${maxBytes}`,
    '--demuxer-max-back-bytes=128MiB',
    '--demuxer-readahead-secs=20',
  ];

  if (opts.headless) {
    args.push('--vo=null', '--ao=null');
  } else {
    args.push(
      // --- decode + render ------------------------------------------------------
      // VideoToolbox drives the media engine; auto-safe avoids known-broken paths.
      '--hwdec=auto-safe',

      ...(opts.nativeMetal
        ? [
            // mpv's Swift/Metal backend. `--vo=gpu` rather than gpu-next: cocoa-cb is
            // not a libplacebo context. `output-csp` sets the Metal layer's colourspace
            // to PQ directly, which is the EDR request MoltenVK may never make.
            '--vo=gpu',
            '--gpu-context=cocoa-cb',
            '--cocoa-cb-output-csp=bt.2100-pq',
          ]
        : [
            '--vo=gpu-next',
            // libplacebo has no Metal backend and OpenGL is deprecated on Apple
            // platforms, so gpu-next goes through MoltenVK. See §2.
            '--gpu-api=vulkan',
          ]),
      // Show a window even while idle, so loading a file is instant.
      '--force-window=yes',

      // --- audio ----------------------------------------------------------------
      // macOS cannot bitstream TrueHD / DTS-HD MA / E-AC3. Always decode to PCM.
      // Do NOT add --audio-spdif here; it silently does nothing on this platform.
      //
      // Deliberately NO `--ao=`. Pinning one was the cause of a silent-playback bug:
      // on some Macs coreaudio cannot set a 5.1 input layout on the audio unit
      // ("unable to set the input channel layout ... -50") and mpv silently falls
      // back to avfoundation, which works. Naming an AO explicitly removes that
      // fallback chain and leaves you with a broken device and no sound — while
      // every other property reads healthy. Let mpv choose.
      // nativeMetal already chose its context above; a second one would conflict.
    ...(opts.gpuContext && !opts.nativeMetal ? [`--gpu-context=${opts.gpuContext}`] : []),
    ...(opts.ao ? [`--ao=${opts.ao}`] : []),
      `--audio-channels=${opts.audioChannels ?? 'auto-safe'}`,
    );

    if (opts.qualityArgs?.length) args.push(...opts.qualityArgs);

    if (opts.shaderCacheDir) {
      args.push('--gpu-shader-cache=yes', `--gpu-shader-cache-dir=${opts.shaderCacheDir}`);
      args.push(`--icc-cache-dir=${opts.shaderCacheDir}`);
    }

    if (opts.hdrPassthrough !== false) {
      // Hand the HDR signal to macOS, which drives the panel's EDR range directly.
      args.push('--target-colorspace-hint=yes');
      if (opts.targetPeak) args.push(`--target-peak=${opts.targetPeak}`);
    } else {
      args.push('--target-colorspace-hint=no', '--tone-mapping=bt.2390', '--hdr-compute-peak=yes');
    }
  }

  if (opts.extra) args.push(...opts.extra);

  // Raw flags bypass filtering entirely and go last, so they win.
  const raw = opts.raw ?? [];

  if (!opts.supported) return [...args, ...raw];

  // Drop anything this build does not know about, rather than letting mpv exit.
  const filtered = args.filter((arg) => {
    const name = arg.match(/^--(?:no-)?([a-z0-9-]+)/)?.[1];
    if (!name) return true;
    return opts.supported!.has(name) || opts.supported!.has(`no-${name}`);
  });
  return [...filtered, ...raw];
}
