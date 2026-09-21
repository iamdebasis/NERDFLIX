import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { LineBuffer } from './mpv-ipc.js';
import { buildMpvArgs } from './mpv-config.js';
import { formatStatus } from './status.js';
import { QUALITY_TIERS, TIER_ORDER, tierToArgs, tierDelta, lowerTier, higherTier, motionToArgs } from './quality.js';
import { ExternalMpvEngine } from './external-mpv.js';
import {
  suggestTier as suggestTierForTest,
  suggestTierForContent,
  QUALITY_MODEL_VERSION,
} from './capabilities.js';

/**
 * Framing is the classic failure point in a JSON-over-socket client: a single 'data'
 * event can carry a partial line, several lines, or both. Every case below has been
 * observed from real mpv output.
 */
describe('LineBuffer', () => {
  test('emits a complete line', () => {
    const b = new LineBuffer();
    assert.deepEqual(b.push('{"a":1}\n'), ['{"a":1}']);
    assert.equal(b.pending, '');
  });

  test('holds a partial line until its newline arrives', () => {
    const b = new LineBuffer();
    assert.deepEqual(b.push('{"a":'), []);
    assert.equal(b.pending, '{"a":');
    assert.deepEqual(b.push('1}\n'), ['{"a":1}']);
  });

  test('splits several lines from one chunk', () => {
    const b = new LineBuffer();
    assert.deepEqual(b.push('{"a":1}\n{"b":2}\n{"c":3}\n'), ['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('handles a chunk containing both complete and partial lines', () => {
    const b = new LineBuffer();
    assert.deepEqual(b.push('{"a":1}\n{"b":'), ['{"a":1}']);
    assert.deepEqual(b.push('2}\n'), ['{"b":2}']);
  });

  test('drops blank lines rather than surfacing them as messages', () => {
    const b = new LineBuffer();
    assert.deepEqual(b.push('\n\n{"a":1}\n\n'), ['{"a":1}']);
  });

  test('survives a line split mid-multibyte-safe boundary across many chunks', () => {
    const b = new LineBuffer();
    const msg = '{"event":"property-change","name":"time-pos","data":12.5}';
    for (const ch of msg) assert.deepEqual(b.push(ch), []);
    assert.deepEqual(b.push('\n'), [msg]);
  });
});

describe('buildMpvArgs', () => {
  test('always keeps the process alive and silent', () => {
    const args = buildMpvArgs({ socketPath: '/tmp/x.sock' });
    for (const required of ['--idle=yes', '--keep-open=yes', '--no-terminal']) {
      assert.ok(args.includes(required), `missing ${required}`);
    }
    assert.ok(args.includes('--input-ipc-server=/tmp/x.sock'));
  });

  test('control ownership is explicit, never contradictory', () => {
    // Appending --osc=yes after --osc=no relied on mpv's last-option-wins, which is
    // a trap for the next reader. One flag decides, and both sets never coexist.
    const own = buildMpvArgs({ socketPath: '/s', ownControls: true });
    assert.ok(own.includes('--osc=yes'));
    assert.ok(own.includes('--input-default-bindings=yes'));
    assert.ok(!own.includes('--osc=no'));

    const silent = buildMpvArgs({ socketPath: '/s' });
    assert.ok(silent.includes('--osc=no'));
    assert.ok(silent.includes('--input-default-bindings=no'));
    assert.ok(!silent.includes('--osc=yes'));
  });

  test('never enables audio passthrough — macOS cannot bitstream HD audio', () => {
    const args = buildMpvArgs({ socketPath: '/tmp/x.sock' });
    assert.ok(!args.some((a) => a.startsWith('--audio-spdif')));
  });

  test('hints the colorspace by default, tone-maps only when told to', () => {
    // Reversed deliberately — see the HDR passthrough tests below.
    const on = buildMpvArgs({ socketPath: '/s' });
    assert.ok(on.includes('--target-colorspace-hint=yes'));

    const off = buildMpvArgs({ socketPath: '/s', hdrPassthrough: false });
    assert.ok(off.includes('--target-colorspace-hint=no'));
    assert.ok(off.includes('--tone-mapping=bt.2390'));
  });

  test('headless mode skips window and audio device setup', () => {
    const args = buildMpvArgs({ socketPath: '/s', headless: true });
    assert.ok(args.includes('--vo=null'));
    assert.ok(args.includes('--ao=null'));
    assert.ok(!args.includes('--force-window=yes'));
  });
});

function mpvAvailable(): boolean {
  try {
    execFileSync('mpv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('ExternalMpvEngine (live)', { skip: !mpvAvailable() && 'mpv not installed' }, () => {
  test('reports a clear error when the binary is missing', async () => {
    const e = new ExternalMpvEngine({ mpvPath: '/nonexistent/mpv', headless: true });
    await assert.rejects(() => e.start(), /failed to spawn mpv/);
    await e.dispose();
  });

  test('starts, answers a property query, and disposes', async () => {
    const e = new ExternalMpvEngine({ headless: true });
    await e.start();
    const idle = await e.get('core-idle');
    assert.equal(typeof idle, 'boolean');
    await e.dispose();
  });

  test('dispose is idempotent', async () => {
    const e = new ExternalMpvEngine({ headless: true });
    await e.start();
    await e.dispose();
    await e.dispose(); // must not throw or hang
  });
});

describe('buildMpvArgs — startup and buffer tuning', () => {
  test('sets a shader cache dir when given one (regression: 5s cold start)', () => {
    // --no-config means mpv picks up no default cache location, so without this every
    // launch recompiles the gpu-next shader set through MoltenVK.
    const args = buildMpvArgs({ socketPath: '/s', shaderCacheDir: '/tmp/shaders' });
    assert.ok(args.includes('--gpu-shader-cache=yes'));
    assert.ok(args.includes('--gpu-shader-cache-dir=/tmp/shaders'));
  });

  test('byte cap is what actually bounds the buffer, and defaults sanely', () => {
    // readahead-secs is a floor; mpv fills until max-bytes. At ~58 Mb/s, 1GiB was
    // buffering 149s and holding 1GB of RAM.
    const dflt = buildMpvArgs({ socketPath: '/s' });
    assert.ok(dflt.includes('--demuxer-max-bytes=512MiB'));

    const big = buildMpvArgs({ socketPath: '/s', maxCacheBytes: '1GiB' });
    assert.ok(big.includes('--demuxer-max-bytes=1GiB'));
    assert.ok(!big.includes('--demuxer-max-bytes=512MiB'));
  });

  test('quality args are injected verbatim and can be empty', () => {
    const withQuality = buildMpvArgs({
      socketPath: '/s',
      qualityArgs: ['--scale=ewa_lanczos4sharpest', '--deband=yes'],
    });
    assert.ok(withQuality.includes('--scale=ewa_lanczos4sharpest'));
    assert.ok(withQuality.includes('--deband=yes'));
    assert.ok(!buildMpvArgs({ socketPath: '/s' }).some((a) => a.startsWith('--scale=')));
  });
});

describe('quality tiers', () => {
  test('tiers are ordered and every tier renders to valid flags', () => {
    for (const tier of TIER_ORDER) {
      const args = tierToArgs(tier);
      assert.ok(args.length > 0, `${tier} produced no flags`);
      for (const a of args) assert.match(a, /^--[a-z0-9-]+=/);
    }
  });

  test('reference is strictly more expensive than efficient', () => {
    const ref = QUALITY_TIERS.reference.options;
    const eff = QUALITY_TIERS.efficient.options;
    assert.equal(eff.deband, 'no');
    assert.equal(ref.deband, 'yes');
    assert.equal(eff.scale, 'bilinear');
    assert.ok(ref.scale.startsWith('ewa_lanczos'));
    // Interpolation is NOT a tier setting — it is a separate cost axis.
    assert.ok(!('interpolation' in ref));
    assert.ok(!('interpolation' in eff));
  });

  test('unsupported options are filtered, not passed to mpv', () => {
    // mpv exits on an unknown option, so a tier referencing something an older build
    // lacks would take the app down rather than degrade.
    const supported = new Set(['scale', 'deband']);
    const args = tierToArgs('reference', supported);
    assert.ok(args.some((a) => a.startsWith('--scale=')));
    assert.ok(args.some((a) => a.startsWith('--deband=')));
    assert.ok(!args.some((a) => a.startsWith('--interpolation=')));
    assert.ok(!args.some((a) => a.startsWith('--deband-iterations=')));
  });

  test('demoting reverts options the lower tier does not set', () => {
    // Without this, stepping down would leave expensive settings running and the
    // demotion would not actually relieve the GPU.
    const delta = tierDelta('reference', 'balanced');
    assert.equal(delta['temporal-dither'], 'no');
    assert.equal(delta.deband, 'no');
    assert.equal(delta.scale, 'spline36');
  });

  test('tier navigation stops at the ends', () => {
    assert.equal(lowerTier('efficient'), null);
    assert.equal(higherTier('reference'), null);
    assert.equal(lowerTier('reference'), 'high');
    assert.equal(higherTier('efficient'), 'balanced');
  });
});


describe('motion interpolation as a separate axis', () => {
  test('is not bundled into any tier', () => {
    // Measured on an M1 Pro / 120Hz ProMotion panel: Reference dropped 1.15% of frames
    // while High dropped 0.42%. video-sync=display-resample renders at the panel rate
    // (120) rather than the film rate (23.976), which is ~5x the work — more than every
    // scaler and deband pass combined.
    for (const tier of TIER_ORDER) {
      assert.ok(!('interpolation' in QUALITY_TIERS[tier].options), `${tier} bundles motion`);
      assert.ok(!('video-sync' in QUALITY_TIERS[tier].options), `${tier} bundles video-sync`);
    }
  });

  test('renders on and off states, filtered by support', () => {
    const on = motionToArgs(true);
    assert.ok(on.includes('--interpolation=yes'));
    assert.ok(on.includes('--video-sync=display-resample'));

    const off = motionToArgs(false);
    assert.ok(off.includes('--interpolation=no'));
    assert.ok(off.includes('--video-sync=audio'));

    assert.deepEqual(motionToArgs(true, new Set(['interpolation'])), ['--interpolation=yes']);
  });
});

describe('tier thresholds (calibrated against measurement)', () => {
  test('Pro-class GPUs start at reference', () => {
    // Measured: M1 Pro / 16 GPU cores runs reference-without-motion at 0.00% drops.
    // The earlier threshold (>=30 cores AND >=32GB) was sized for tiers that bundled
    // motion interpolation, and was wrong once that was split out.
    assert.equal(suggestTierForTest(16, 16), 'reference');
    assert.equal(suggestTierForTest(38, 64), 'reference');
  });

  test('base and low-power chips step down', () => {
    assert.equal(suggestTierForTest(8, 8), 'high');
    assert.equal(suggestTierForTest(5, 8), 'balanced');
    assert.equal(suggestTierForTest(2, 4), 'efficient');
  });

  test('unknown GPU falls back to a safe middle, never a crash', () => {
    assert.equal(suggestTierForTest(null, 16), 'high');
  });
});

describe('audio output', () => {
  test('stereo downmix is available but not the default', () => {
    const args = buildMpvArgs({ socketPath: '/s', audioChannels: 'stereo' });
    assert.ok(args.includes('--audio-channels=stereo'));
  });

  test('never attempts passthrough — macOS cannot bitstream HD audio', () => {
    for (const ch of ['stereo', 'auto-safe', 'auto']) {
      const args = buildMpvArgs({ socketPath: '/s', audioChannels: ch });
      assert.ok(!args.some((a) => a.startsWith('--audio-spdif')));
    }
  });
});

describe('audio output (regression: pinned AO caused silence)', () => {
  test('never pins an audio output, so mpv can fall back', () => {
    // On the affected Mac:
    //   [ao/coreaudio] unable to set the input channel layout ... (-50)
    //   AO: [avfoundation] 48000Hz 5.1(side) 6ch     <- works
    // mpv recovers automatically. Naming `--ao=coreaudio` removed that fallback and
    // left a broken device with no sound, while every property read healthy.
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(!args.some((a) => a.startsWith('--ao=')), 'must not pin an AO');
  });

  test('an AO can still be forced for diagnosis', () => {
    const args = buildMpvArgs({ socketPath: '/s', ao: 'avfoundation' });
    assert.ok(args.includes('--ao=avfoundation'));
  });

  test("defaults to mpv's own channel handling, which is known good", () => {
    // Plain `mpv --no-config` plays this 5.1 content correctly on the same hardware,
    // so matching its default is the safest baseline.
    assert.ok(buildMpvArgs({ socketPath: '/s' }).includes('--audio-channels=auto-safe'));
  });
});

describe('capability cache versioning', () => {
  test('the model version is exported so a stale ceiling can be detected', () => {
    // observedCeiling is a verdict about a specific set of tier definitions. When
    // motion interpolation moved out of the tiers, Reference became far cheaper —
    // but a machine demoted under the old definitions kept starting at High
    // forever, silently capped with no way to know why.
    assert.equal(typeof QUALITY_MODEL_VERSION, 'number');
    assert.ok(QUALITY_MODEL_VERSION >= 2, 'bump this when tier costs change');
  });
});

describe('tier vs content resolution', () => {
  test('4K pulls a Pro-class GPU down from Reference to High', () => {
    // Measured on M1 Pro / 16 GPU cores playing a 2160p DV REMUX: Reference dropped
    // ~6% of frames on real footage. An earlier "runs clean" reading came from 25
    // seconds of a near-static studio logo — the wrong workload entirely.
    assert.equal(suggestTierForContent('reference', 2160, 16), 'high');
  });

  test('1080p keeps Reference on the same GPU', () => {
    // A quarter of the pixels; the expensive passes scale with pixel count.
    assert.equal(suggestTierForContent('reference', 1080, 16), 'reference');
  });

  test('a much larger GPU still attempts Reference at 4K', () => {
    assert.equal(suggestTierForContent('reference', 2160, 38), 'reference');
  });

  test('never adjusts upward, and leaves lower tiers alone', () => {
    assert.equal(suggestTierForContent('high', 2160, 16), 'high');
    assert.equal(suggestTierForContent('balanced', 2160, 8), 'balanced');
  });

  test('unknown resolution changes nothing', () => {
    assert.equal(suggestTierForContent('reference', null, 16), 'reference');
  });
});

describe('option filtering covers extras', () => {
  test('unknown options never reach mpv', () => {
    // mpv exits on an unrecognised option. Extras are exactly where version-specific
    // flags appear, so leaving them unfiltered crashes the player on some builds.
    const supported = new Set(['geometry', 'focus-on-open']);
    const args = buildMpvArgs({
      socketPath: '/s',
      supported,
      extra: ['--geometry=100%x100%+0+0', '--focus-on=never', '--no-focus-on-open', '--nonsense'],
    });
    assert.ok(args.includes('--geometry=100%x100%+0+0'));
    assert.ok(args.includes('--no-focus-on-open'), 'the spelling this build knows survives');
    assert.ok(!args.includes('--focus-on=never'), 'the spelling it does not know is dropped');
    assert.ok(!args.some((a) => a.includes('nonsense')));
  });

  test('without a supported set nothing is filtered', () => {
    const args = buildMpvArgs({ socketPath: '/s', extra: ['--anything=1'] });
    assert.ok(args.includes('--anything=1'));
  });

  test('negated forms are matched against the positive option name', () => {
    const args = buildMpvArgs({
      socketPath: '/s',
      supported: new Set(['keepaspect-window']),
      extra: ['--no-keepaspect-window'],
    });
    assert.ok(args.includes('--no-keepaspect-window'));
  });
});

describe('who draws the controls', () => {
  test('by default mpv draws nothing and intercepts nothing', () => {
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(args.includes('--osc=no'));
    assert.ok(args.includes('--input-default-bindings=no'));
  });

  test('ownControls hands the interface to mpv without duplicate flags', () => {
    // The app settled on mpv owning playback: two windows in two processes cannot be
    // kept in agreement on macOS. Relying on mpv's last-flag-wins to override an
    // earlier --osc=no worked but was fragile; the flag must appear exactly once.
    const args = buildMpvArgs({ socketPath: '/s', ownControls: true });
    assert.equal(args.filter((a) => a.startsWith('--osc=')).length, 1);
    assert.ok(args.includes('--osc=yes'));
    assert.ok(args.includes('--input-default-bindings=yes'));
    assert.ok(!args.includes('--no-border'));
  });
});

describe('player window chrome', () => {
  test('mpv keeps its title bar when it owns the window', () => {
    // The title bar carries the close button. Without it the only way out is `q`,
    // which nobody discovers.
    const args = buildMpvArgs({ socketPath: '/s', ownControls: true });
    assert.ok(args.includes('--border=yes'));
    assert.ok(!args.includes('--no-border'));
  });

  test('borderless only when something else draws the controls', () => {
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(args.includes('--no-border'));
  });
});

describe('quality recovery (regression: demotion ratchet)', () => {
  test('climbs back one step at a time', () => {
    // A 16-core M1 Pro ended up running at 'Efficient' because the watchdog only ever
    // demoted and the ceiling was persisted. One bad sample pinned the machine there.
    assert.equal(higherTier('efficient', 'high'), 'balanced');
    assert.equal(higherTier('balanced', 'high'), 'high');
  });

  test('never climbs past what the hardware and content warrant', () => {
    assert.equal(higherTier('high', 'high'), null);
    assert.equal(higherTier('reference', 'high'), null);
  });

  test('without a ceiling it still stops at the top', () => {
    assert.equal(higherTier('reference'), null);
    assert.equal(higherTier('high'), 'reference');
  });
});

describe('HDR passthrough', () => {
  test('is on by default', () => {
    // It was off out of caution over MoltenVK crashes and ProMotion vsync jitter.
    // Neither appeared in testing, while the cost was real: a Dolby Vision remux on a
    // 1600-nit XDR panel was being flattened to SDR.
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(args.includes('--target-colorspace-hint=yes'));
    assert.ok(!args.some((a) => a.startsWith('--tone-mapping=')));
  });

  test('tone-maps when explicitly disabled for an SDR display', () => {
    const args = buildMpvArgs({ socketPath: '/s', hdrPassthrough: false });
    assert.ok(args.includes('--target-colorspace-hint=no'));
    assert.ok(args.includes('--tone-mapping=bt.2390'));
  });
});

describe('playback status reports reality, not config', () => {
  const base = {
    source: { width: 3840, height: 2160, codec: 'hevc', bitDepth: 10, primaries: 'bt.2020',
      gamma: 'pq', maxLuma: 1000, isHdr: true, dolbyVision: true },
    output: { primaries: 'bt.2020', gamma: 'pq', isHdr: true },
    hwdec: 'videotoolbox',
    targetPeak: 'auto',
    renderer: 'mpv' as const,
    audio: { codec: 'truehd', inChannels: 8, outChannels: 2, layout: 'stereo', ao: 'coreaudio' },
  };

  test('confirms HDR only when it was requested AND survived', () => {
    const ok = formatStatus({ ...base, hdrRequested: true, hdrPreserved: true }).join('\n');
    assert.match(ok, /HDR passthrough/);
  });

  test('says so plainly when passthrough is off', () => {
    // This is the case that went unnoticed for weeks: config claimed HDR, the display
    // got SDR, and nothing ever compared the two.
    const off = formatStatus({
      ...base,
      hdrRequested: false,
      hdrPreserved: false,
    }).join('\n');
    assert.match(off, /tone-mapped to SDR/);
  });

  test('distinguishes "we asked and were refused" from "we never asked"', () => {
    const refused = formatStatus({
      ...base,
      output: { primaries: 'bt.709', gamma: 'bt.1886', isHdr: false },
      hdrRequested: true,
      hdrPreserved: false,
    }).join('\n');
    assert.match(refused, /declined/);
  });

  test('an SDR file is not dressed up as HDR', () => {
    const sdr = formatStatus({
      ...base,
      source: { ...base.source, gamma: 'bt.1886', primaries: 'bt.709', isHdr: false, dolbyVision: false },
      output: { primaries: 'bt.709', gamma: 'bt.1886', isHdr: false },
      hdrRequested: true,
      hdrPreserved: true,
    }).join('\n');
    assert.match(sdr, /SDR source/);
    assert.doesNotMatch(sdr, /passthrough/);
  });

  test('software decode is flagged, not buried', () => {
    const soft = formatStatus({ ...base, hwdec: null, hdrRequested: true, hdrPreserved: true }).join('\n');
    assert.match(soft, /software decode/);
  });
});

describe('the promotion ceiling is the hardware rating, not the demotion', () => {
  test('a machine demoted to Balanced can still climb back to High', () => {
    // The bug: the promotion limit was set to the STARTING tier, which on the next
    // session is the persisted demotion. Demoted to Balanced once, it could never
    // climb past Balanced again — a ratchet one step slower than the original.
    assert.equal(higherTier('balanced', 'high'), 'high');
  });

  test('but never past what 4K on that GPU warrants', () => {
    const ceiling = suggestTierForContent('reference', 2160, 16);
    assert.equal(ceiling, 'high');
    assert.equal(higherTier('high', ceiling), null);
  });
});

describe('no ceiling survives a session (regression: pinned at Efficient)', () => {
  test('recording a ceiling is a no-op', async () => {
    // Persisting the measured ceiling caused three bugs in a row and left a 16-core
    // M1 Pro starting every session at 'Efficient' — the worst moment it ever had,
    // applied forever. The watchdog reacts in ~10s, so nothing needs carrying over.
    const { recordObservedCeiling, detectCapabilities } = await import('./capabilities.js');
    const before = await detectCapabilities();
    await recordObservedCeiling('efficient');
    const after = await detectCapabilities(false);
    assert.equal(after.observedCeiling, before.observedCeiling);
  });
});

describe('playback always starts at the hardware rating', () => {
  test('a 16-core machine is rated for Reference, capped to High on 4K', () => {
    // Regression: playback used to START at observedCeiling, so one heavy session left
    // every later film beginning at 'Efficient' — bilinear scaling, no debanding — on a
    // machine rated far higher. A past fallback must not set the starting point.
    const rated = suggestTierForTest(16, 16);
    assert.equal(rated, 'reference');
    assert.equal(suggestTierForContent(rated, 2160, 16), 'high');
  });

  test('and 1080p on the same machine keeps Reference', () => {
    assert.equal(suggestTierForContent(suggestTierForTest(16, 16), 1080, 16), 'reference');
  });
});

describe('the promotion ceiling narrows once the content is known', () => {
  test('4K caps a Reference-rated machine at High', () => {
    // The watchdog starts before any file is loaded, so a ceiling captured at that
    // moment is the HARDWARE rating — Reference on 16 cores. The content adjustment
    // that narrows it to High only runs after file-loaded, because the resolution is
    // unknown until then. Reading it live is what keeps 2160p out of Reference.
    const hardware = suggestTierForTest(16, 16);
    assert.equal(hardware, 'reference');

    const forThisFile = suggestTierForContent(hardware, 2160, 16);
    assert.equal(forThisFile, 'high');
    assert.equal(higherTier('high', forThisFile), null, 'must not climb past High on 4K');
  });

  test('1080p on the same machine may still reach Reference', () => {
    const forThisFile = suggestTierForContent(suggestTierForTest(16, 16), 1080, 16);
    assert.equal(higherTier('high', forThisFile), 'reference');
  });
});

describe('HDR target peak', () => {
  test('is left to mpv unless told otherwise', () => {
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(!args.some((a) => a.startsWith('--target-peak=')));
  });

  test('can be asserted for a display mpv underestimates', () => {
    // mpv's `auto` asks the windowing system, and on macOS before 0.38 that
    // negotiation is weak. An underestimate makes HDR look DIMMER than tone-mapped
    // SDR, because the highlights have nowhere to go.
    const args = buildMpvArgs({ socketPath: '/s', targetPeak: 1600 });
    assert.ok(args.includes('--target-peak=1600'));
  });

  test('is meaningless without passthrough, so it is not sent', () => {
    const args = buildMpvArgs({ socketPath: '/s', hdrPassthrough: false, targetPeak: 1600 });
    assert.ok(!args.some((a) => a.startsWith('--target-peak=')));
  });
});

describe('GPU context', () => {
  test('is left to mpv by default', () => {
    // `auto` is usually right, and a wrong value here means no video at all.
    assert.ok(!buildMpvArgs({ socketPath: '/s' }).some((a) => a.startsWith('--gpu-context=')));
  });

  test('can be forced to the Metal path for HDR on macOS', () => {
    // macOS OpenGL cannot do EDR — it is deprecated there and capped at SDR — so
    // passthrough is signalled and SDR comes out, looking exactly as dim as if
    // tone-mapping were still on. Only macvk (Vulkan via MoltenVK) can request it.
    assert.ok(buildMpvArgs({ socketPath: '/s', gpuContext: 'macvk' }).includes('--gpu-context=macvk'));
  });
});

describe('Metal path selection', () => {
  test('an explicit context always wins over the probe', () => {
    assert.ok(
      buildMpvArgs({ socketPath: '/s', gpuContext: 'cocoa' }).includes('--gpu-context=cocoa'),
    );
  });

  test('nothing is passed when no context was chosen or found', () => {
    // Critical: an unavailable gpu-context VALUE is a FATAL error — mpv exits and
    // there is no video at all. The option filter cannot catch it, because it checks
    // names and `gpu-context` is a valid name everywhere. Passing nothing is safe.
    assert.ok(!buildMpvArgs({ socketPath: '/s' }).some((a) => a.startsWith('--gpu-context=')));
  });
});

describe('raw mpv passthrough', () => {
  test('bypasses the option filter and goes last so it wins', () => {
    // For platform-specific options a probe on another OS cannot confirm. The trade is
    // explicit: a bad flag stops mpv starting, which is acceptable for an experiment
    // lever and not acceptable anywhere else.
    const args = buildMpvArgs({
      socketPath: '/s',
      supported: new Set(['osc']),
      raw: ['--cocoa-cb-output-csp=bt.2100-pq'],
    });
    assert.equal(args.at(-1), '--cocoa-cb-output-csp=bt.2100-pq');
  });

  test('nothing is appended when none is given', () => {
    const args = buildMpvArgs({ socketPath: '/s', supported: new Set(['osc']) });
    assert.ok(!args.some((a) => a.includes('cocoa-cb')));
  });
});

describe('video flags are reportable', () => {
  test('the video-relevant flags can be picked out of a launch line', () => {
    // mpv reports what was ASKED for, never what it resolved `auto` to, so showing
    // what we passed is the only way to confirm an experiment reached it. Without
    // this the log looked identical whether NFL_MPV_ARGS applied or not.
    const args = buildMpvArgs({
      socketPath: '/s',
      gpuContext: 'macvk',
      raw: ['--cocoa-cb-output-csp=bt.2100-pq'],
    });
    const video = args.filter((a) => /^--(gpu-|target-|tone-|cocoa-|vo=|hwdec|icc-)/.test(a));
    assert.ok(video.includes('--gpu-context=macvk'));
    assert.ok(video.includes('--cocoa-cb-output-csp=bt.2100-pq'));
    assert.ok(!video.some((a) => a.startsWith('--osc')), 'only video flags');
  });
});

describe('native Metal path', () => {
  test('replaces the Vulkan stack rather than being added to it', () => {
    // cocoa-cb is NOT a Vulkan context. Passing --gpu-api=vulkan alongside it is
    // contradictory, and doing so silently wasted two rounds of testing: the flags
    // looked applied but the native path was never actually taken.
    const args = buildMpvArgs({ socketPath: '/s', nativeMetal: true });
    assert.ok(args.includes('--vo=gpu'));
    assert.ok(args.includes('--gpu-context=cocoa-cb'));
    assert.ok(!args.includes('--gpu-api=vulkan'));
    assert.ok(!args.includes('--vo=gpu-next'));
  });

  test('the default path is unchanged', () => {
    const args = buildMpvArgs({ socketPath: '/s' });
    assert.ok(args.includes('--vo=gpu-next'));
    assert.ok(args.includes('--gpu-api=vulkan'));
    assert.ok(!args.some((a) => a.includes('cocoa-cb')));
  });

  test('an auto-selected context never fights the native path', () => {
    // Two --gpu-context flags would conflict; nativeMetal already chose one.
    const args = buildMpvArgs({ socketPath: '/s', nativeMetal: true, gpuContext: 'macvk' });
    assert.equal(args.filter((a) => a.startsWith('--gpu-context=')).length, 1);
    assert.ok(args.includes('--gpu-context=cocoa-cb'));
  });
});

describe('IINA engine selection', () => {
  test('a missing iina-cli is reported, not guessed at', async () => {
    const { findIinaCli } = await import('./iina.js');
    assert.equal(await findIinaCli('/nonexistent/iina-cli'), null);
  });

  test('the socket path is where IINA must be told to put it', async () => {
    // iina-cli IGNORES --input-* options, so the socket cannot be passed per launch.
    // It has to match what the user sets in IINA's Additional mpv options, and the
    // engine refuses to start rather than silently losing watch history.
    const { DEFAULT_IINA_SOCKET } = await import('./iina.js');
    assert.match(DEFAULT_IINA_SOCKET, /^\/tmp\/.+\.sock$/);
  });

  test('the configuration error tells the user exactly what to do', async () => {
    const { IinaNotConfiguredError } = await import('./iina.js');
    const msg = new IinaNotConfiguredError('/tmp/x.sock').message;
    assert.match(msg, /Additional mpv options/);
    assert.match(msg, /input-ipc-server=\/tmp\/x\.sock/);
  });
});

describe('status when a host app renders', () => {
  const hdrSource = {
    source: { width: 3840, height: 2160, codec: 'hevc', bitDepth: 10, primaries: 'bt.2020',
      gamma: 'pq', maxLuma: 4000, isHdr: true, dolbyVision: true },
    output: { primaries: 'bt.709', gamma: 'bt.1886', isHdr: false },
    hwdec: 'videotoolbox',
    targetPeak: 'auto',
    audio: { codec: 'dts', inChannels: 6, outChannels: 2, layout: 'stereo', ao: 'coreaudio' },
  };

  test('does not claim tone-mapping it cannot observe', () => {
    // With vo=libmpv the host owns presentation, so mpv's output params describe
    // nothing real. Reporting "tone-mapped to SDR" from them was a guess presented as
    // a measurement — and it was wrong while HDR was in fact working.
    const out = formatStatus({
      ...hdrSource, renderer: 'host', hdrRequested: false, hdrPreserved: false,
    }).join('\n');
    assert.match(out, /HDR source/);
    assert.match(out, /presented by the player/);
    assert.doesNotMatch(out, /tone-mapped/);
    assert.doesNotMatch(out, /--no-hdr/);
  });

  test('still reports what IS known about the file', () => {
    const out = formatStatus({
      ...hdrSource, renderer: 'host', hdrRequested: false, hdrPreserved: false,
    }).join('\n');
    assert.match(out, /HDR10 \(PQ\)/);
    assert.match(out, /4,000 nits/);
  });

  test('mpv rendering is still judged normally', () => {
    const out = formatStatus({
      ...hdrSource, renderer: 'mpv', hdrRequested: false, hdrPreserved: false,
    }).join('\n');
    assert.match(out, /tone-mapped to SDR/);
  });
});

describe('HDR verdict depends on who is rendering', () => {
  const hdr = {
    source: { width: 3840, height: 2160, codec: 'hevc', bitDepth: 10, primaries: 'bt.2020',
      gamma: 'pq', maxLuma: 4000, isHdr: true, dolbyVision: true },
    output: { primaries: 'bt.2020', gamma: 'pq', isHdr: true },
    hwdec: 'videotoolbox',
    targetPeak: 'auto',
    audio: { codec: 'dts', inChannels: 6, outChannels: 2, layout: 'stereo', ao: 'coreaudio' },
  };

  test('a host renderer is never accused of tone-mapping', () => {
    // IINA drives the CAMetalLayer itself, so --target-colorspace-hint is irrelevant
    // and mpv's output params describe nothing real. Requiring the hint reported
    // "tone-mapped to SDR" over demonstrably working HDR.
    const out = formatStatus({
      ...hdr, renderer: 'host', hdrRequested: true, hdrPreserved: true,
    }).join('\n');
    assert.match(out, /presented by the player/);
    assert.doesNotMatch(out, /tone-mapped/);
  });

  test('and its peak is not ours to report', () => {
    // mpv's target-peak says nothing about what the host negotiated.
    const out = formatStatus({
      ...hdr, renderer: 'host', hdrRequested: true, hdrPreserved: true,
    }).join('\n');
    assert.doesNotMatch(out, /display peak/);
  });

  test('bare mpv still requires the hint', () => {
    const out = formatStatus({
      ...hdr, renderer: 'mpv', hdrRequested: false, hdrPreserved: false,
    }).join('\n');
    assert.match(out, /tone-mapped to SDR/);
  });
});
