import logo from './assets/nerdflix.png';

/**
 * The NERDFLIX wordmark.
 *
 * A supplied image asset, not generated. Earlier versions set the word in a typeface
 * and then drew the glyphs as paths; both were serviceable and neither was as good as
 * a mark someone actually designed. Real logos are artwork, so this ships the artwork.
 *
 * The source had a dark background and letters touching the edges. It is stored cut
 * out to transparency — alpha derived per pixel so the antialiased edges stay smooth —
 * trimmed to the letters, then padded, so it sits correctly over the nav gradient and
 * the hero image behind it.
 *
 * Sized by HEIGHT alone. The width follows from the asset's own aspect ratio, so the
 * mark can never be stretched by a layout change.
 */

type Props = {
  /** Rendered height in pixels. Width follows the artwork's aspect ratio. */
  size?: number;
  className?: string;
};

export function Wordmark({ size = 22, className }: Props) {
  return (
    <img
      className={className}
      src={logo}
      alt="Nerdflix"
      height={size}
      style={{ height: size, width: 'auto', display: 'block', userSelect: 'none' }}
      draggable={false}
    />
  );
}
