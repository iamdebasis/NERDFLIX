/**
 * A drive's face.
 *
 * Netflix puts a person on a profile card. We have a shelf of films, so the card
 * shows exactly that: disc spines standing on a shelf, viewed edge-on. Spine count
 * scales with how many titles the drive holds, and the whole arrangement is derived
 * deterministically from the drive's id — so a given drive always looks identical
 * and becomes recognisable at a glance, the way a face would.
 *
 * Chosen over the obvious alternative (a big number with a small label) because that
 * treatment appears on every dashboard ever made, and because a shelf actually says
 * something true about the subject: this is physical media on a physical disk.
 */

/** Small deterministic PRNG — same drive, same shelf, every launch. */
function makeRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Props = {
  seed: string;
  titleCount: number;
  size?: number;
  /**
   * Extra library ids, for the combined "all films" card.
   *
   * Their identity hues are mixed into the spines so the shelf visibly contains films
   * from each library. Drawn as ONE shelf rather than a stack of them: a combined
   * library is genuinely one shelf holding everything, and stacking clipped shelf
   * strips just read as coloured blocks.
   */
  mixSeeds?: string[];
};

export function ShelfFace({ seed, titleCount, size = 168, mixSeeds }: Props) {
  const rand = makeRandom(seed);

  /** One identity hue per contributing library, to colour the spines from. */
  const mixHues = (mixSeeds ?? []).map((s) => {
    const r = makeRandom(s);
    return Math.floor(r() * 360);
  });
  // Nothing scanned yet: show the shelf, empty. Inventing spines for a drive we have
  // not read would contradict the "Not scanned yet" caption sitting right below it.
  const empty = titleCount <= 0;

  // Backdrop hue is the drive's identity colour. Kept dark and desaturated so the
  // spines read against it and so a row of cards never turns into a colour riot.
  const baseHue = Math.floor(rand() * 360);


  const padding = size * 0.12;
  const shelfY = size - padding;
  const usable = size - padding * 2;

  /**
   * Spines are a roughly constant width — a disc case is a disc case — and the library
   * size decides how much of the shelf fills up. They pack from the left with tight
   * gaps and leave the remainder of the shelf empty.
   *
   * The earlier version spread N spines evenly across the full width, which at low
   * counts produced a handful of tall bars with wide gaps: a bar chart, which is
   * precisely the reading this design exists to avoid. Packing fixes it, and an
   * unscanned drive now correctly shows an empty shelf instead of inventing films.
   */
  const unit = size * 0.055;
  const gap = unit * 0.14;
  const maxSpines = Math.floor(usable / unit);
  const spineCount =
    titleCount <= 0 ? 0 : Math.max(1, Math.min(maxSpines, Math.round(Math.sqrt(titleCount) * 1.7)));

  // Widths first, so the packed group can be centred. Left-packing was honest about
  // shelf fullness but made a 3-film library look like a rendering fault: five spines
  // huddled in the corner with two thirds of the card empty. Centring keeps the
  // fullness signal — a big library still spans the shelf — while staying composed.
  const widths = Array.from({ length: spineCount }, () => unit * (0.74 + rand() * 0.2));
  const groupWidth = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, spineCount - 1);

  let cursor = (size - groupWidth) / 2;
  const spines = widths.map((w) => {
    const h = usable * (0.4 + rand() * 0.46);
    // On the combined card, draw each spine from one of the contributing libraries'
    // hues so the shelf reads as films from several places standing together.
    const family =
      mixHues.length > 0 ? mixHues[Math.floor(rand() * mixHues.length)] : baseHue;
    const hue = (family + (rand() * 46 - 23) + (rand() > 0.82 ? 180 : 0)) % 360;
    const bright = rand() > 0.78;
    const light = bright ? 52 + rand() * 16 : 28 + rand() * 20;
    const sat = bright ? 46 : 22 + rand() * 16;
    // An occasional lean, the way a shelf that is not quite full actually looks.
    const lean = rand() > 0.9 ? (rand() * 9 - 4.5).toFixed(1) : '0';
    const x = cursor;
    cursor += w + gap;
    return { x, y: shelfY - h, w, h, hue, light, sat, lean };
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={`bg-${seed}`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor={`hsl(${baseHue} 32% 22%)`} />
          <stop offset="100%" stopColor={`hsl(${(baseHue + 28) % 360} 38% 11%)`} />
        </linearGradient>
      </defs>

      <rect width={size} height={size} fill={`url(#bg-${seed})`} />

      {spines.map((s, i) => (
        <rect
          key={i}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={Math.min(1.5, s.w * 0.14)}
          fill={`hsl(${s.hue} ${s.sat}% ${s.light}%)`}
          transform={s.lean !== '0' ? `rotate(${s.lean} ${s.x + s.w / 2} ${shelfY})` : undefined}
        />
      ))}

      {/* The shelf itself — the line that makes the bars read as objects, not a chart. */}
      <rect
        x={padding * 0.55}
        y={shelfY}
        width={size - padding * 1.1}
        height={Math.max(2, size * 0.018)}
        rx={1}
        fill="rgba(255,255,255,0.5)"
      />
    </svg>
  );
}
