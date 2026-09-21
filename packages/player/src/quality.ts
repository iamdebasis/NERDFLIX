/**
 * Quality tiers.
 *
 * mpv's own `--profile=high-quality` is surprisingly thin — it sets only
 * scale=ewa_lanczossharp, deband=yes, and two HDR peak parameters. That leaves a lot
 * of headroom, which is what `reference` uses.
 *
 * The tier is chosen at runtime (see capabilities.ts) and corrected live by the
 * frame-drop watchdog, so a Mac Studio driving a Pro Display XDR and a fanless Air
 * both end up at the best setting *they* can sustain. Nothing here is tuned for one
 * specific machine — see ARCHITECTURE.md §2.1.
 */

export type QualityTier = 'efficient' | 'balanced' | 'high' | 'reference';

export const TIER_ORDER: QualityTier[] = ['efficient', 'balanced', 'high', 'reference'];

export type TierDefinition = {
  tier: QualityTier;
  label: string;
  description: string;
  /** mpv options as name→value. Applied as --name=value, and settable at runtime. */
  options: Record<string, string>;
};

/**
 * Notes on the expensive settings, so nobody trims them without knowing the cost:
 *
 * - `scale`/`dscale`/`cscale` dominate GPU cost. ewa_lanczos4sharpest is the sharpest
 *   upscaler libplacebo offers; mitchell is the standard choice for downscaling because
 *   it minimises ringing, which matters constantly here (4K onto a smaller panel).
 * - `correct-downscaling` + `linear-downscaling` make downscaling gamma-correct. This is
 *   the single most visible quality win when a 4K film is shown on a laptop display.
 * - `deband` matters far more than it sounds on this library: dark, graded scenes like
 *   the Batman Begins cave sequence band visibly even in 10-bit.
 * - `interpolation` + `tscale=oversample` reduces 23.976→120Hz judder WITHOUT the
 *   soap-opera look that motion interpolation implies. `oversample` only redistributes
 *   frame timing; it does not synthesise intermediate frames.
 * - `video-sync=display-resample` is required for interpolation to do anything useful.
 */
export const QUALITY_TIERS: Record<QualityTier, TierDefinition> = {
  efficient: {
    tier: 'efficient',
    label: 'Efficient',
    description: 'Lowest GPU load. For battery, or a display that is not the focus.',
    options: {
      scale: 'bilinear',
      dscale: 'bilinear',
      cscale: 'bilinear',
      deband: 'no',
      'dither-depth': 'auto',
    },
  },

  balanced: {
    tier: 'balanced',
    label: 'Balanced',
    description: 'mpv defaults plus correct downscaling. Good on any Apple Silicon.',
    options: {
      scale: 'spline36',
      dscale: 'mitchell',
      cscale: 'spline36',
      'correct-downscaling': 'yes',
      'linear-downscaling': 'yes',
      deband: 'no',
      'dither-depth': 'auto',
    },
  },

  high: {
    tier: 'high',
    label: 'High',
    description: 'Sharp scaling, debanding, gamma-correct downscaling.',
    options: {
      scale: 'ewa_lanczossharp',
      'scale-antiring': '0.7',
      dscale: 'mitchell',
      'dscale-antiring': '0.7',
      cscale: 'ewa_lanczossharp',
      'correct-downscaling': 'yes',
      'linear-downscaling': 'yes',
      'sigmoid-upscaling': 'yes',
      deband: 'yes',
      'deband-iterations': '2',
      'deband-threshold': '35',
      'deband-range': '16',
      'deband-grain': '5',
      'dither-depth': 'auto',
      'temporal-dither': 'yes',
      'hdr-peak-percentile': '99.995',
      'hdr-contrast-recovery': '0.30',
    },
  },

  reference: {
    tier: 'reference',
    label: 'Reference',
    description: 'Everything on. For Mac Studio / Pro class GPUs driving large displays.',
    options: {
      scale: 'ewa_lanczos4sharpest',
      'scale-antiring': '0.8',
      dscale: 'mitchell',
      'dscale-antiring': '0.8',
      cscale: 'ewa_lanczos4sharpest',
      'correct-downscaling': 'yes',
      'linear-downscaling': 'yes',
      'sigmoid-upscaling': 'yes',
      deband: 'yes',
      'deband-iterations': '4',
      'deband-threshold': '48',
      'deband-range': '16',
      'deband-grain': '8',
      'dither-depth': 'auto',
      'temporal-dither': 'yes',
      'hdr-compute-peak': 'yes',
      'hdr-peak-percentile': '99.995',
      'hdr-contrast-recovery': '0.30',
      'gamut-mapping-mode': 'perceptual',
    },
  },
};

/** Render a tier as mpv command-line flags, dropping any this build does not support. */
export function tierToArgs(tier: QualityTier, supported?: Set<string>): string[] {
  const def = QUALITY_TIERS[tier];
  return Object.entries(def.options)
    .filter(([name]) => !supported || supported.has(name))
    .map(([name, value]) => `--${name}=${value}`);
}

/** Options that differ between two tiers, for applying a change without a restart. */
export function tierDelta(from: QualityTier, to: QualityTier): Record<string, string> {
  const a = QUALITY_TIERS[from].options;
  const b = QUALITY_TIERS[to].options;
  const delta: Record<string, string> = {};

  for (const [k, v] of Object.entries(b)) {
    if (a[k] !== v) delta[k] = v;
  }
  // Anything the previous tier set but the new one does not must be reverted, or a
  // demotion would silently keep the expensive setting alive.
  for (const k of Object.keys(a)) {
    if (!(k in b)) delta[k] = defaultFor(k);
  }
  return delta;
}

/** mpv's own default, used when a tier stops specifying an option. */
function defaultFor(name: string): string {
  switch (name) {
    case 'deband':
    case 'temporal-dither':
    case 'correct-downscaling':
    case 'linear-downscaling':
    case 'sigmoid-upscaling':
    case 'hdr-compute-peak':
      return 'no';
    case 'video-sync':
      return 'audio';
    case 'tscale':
      return 'oversample';
    case 'scale':
    case 'cscale':
      return 'bilinear';
    case 'dscale':
      return '';
    default:
      return 'no';
  }
}

/**
 * Motion interpolation, kept OUT of the tiers on purpose.
 *
 * `video-sync=display-resample` renders at the display's refresh rate rather than the
 * film's. On a 120 Hz ProMotion panel showing 23.976 fps content that is roughly 5x the
 * render work — by far the most expensive single setting available, and far more costly
 * than every scaler and deband pass combined.
 *
 * It is also the one setting whose absence costs no detail: it reduces judder, it does
 * not sharpen or clean the image. So when the GPU is struggling this is the first thing
 * to go, before any tier demotion touches actual picture quality.
 */
export const MOTION_OPTIONS: Record<string, string> = {
  interpolation: 'yes',
  tscale: 'oversample',
  'video-sync': 'display-resample',
};

export const MOTION_OFF: Record<string, string> = {
  interpolation: 'no',
  'video-sync': 'audio',
};

export function motionToArgs(enabled: boolean, supported?: Set<string>): string[] {
  const opts = enabled ? MOTION_OPTIONS : MOTION_OFF;
  return Object.entries(opts)
    .filter(([name]) => !supported || supported.has(name))
    .map(([name, value]) => `--${name}=${value}`);
}

export function lowerTier(tier: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i > 0 ? TIER_ORDER[i - 1] : null;
}

/**
 * One step up, never past `ceiling` when given.
 *
 * The cap is what stops a machine that genuinely cannot sustain a tier from climbing
 * into it repeatedly: the watchdog may recover ground it lost, not claim new ground.
 */
export function higherTier(tier: QualityTier, ceiling?: QualityTier): QualityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  if (i < 0 || i >= TIER_ORDER.length - 1) return null;
  if (ceiling) {
    const max = TIER_ORDER.indexOf(ceiling);
    if (max < 0 || i >= max) return null;
  }
  return TIER_ORDER[i + 1];
}
