/**
 * Turning a file's stored tracks into something a person can choose from.
 *
 * Two things make this worth its own module. The first is the ID mapping: mpv numbers
 * tracks 1..N PER TYPE, while ffprobe reports one stream index across all types — so
 * the third audio stream is `aid=3` but stream index 3 might be a subtitle. The array
 * position is what carries the mapping, because `probe.ts` builds each list by
 * filtering streams in container order, which is the order mpv numbers them in.
 * Verified against a real remux: ffprobe's four audio streams came back as mpv
 * `--aid=1..4`, in the same order, with the same titles.
 *
 * The second is labelling. A disc can carry twenty-five subtitle tracks and four audio
 * tracks including two commentaries, and "English / English / English" is not a choice.
 */

import type { MediaFile, Title } from '@nfl/core';
import type { TrackChoice, TrackOption } from '../shared/types.js';

/** mpv's `aid`/`sid` are 1-based within their own type. */
export const mpvTrackId = (arrayIndex: number): number => arrayIndex + 1;

/** ISO 639-2 for the handful a Blu-ray actually ships, so the list reads as words. */
const LANGUAGES: Record<string, string> = {
  eng: 'English', en: 'English',
  fra: 'French', fre: 'French', fr: 'French',
  deu: 'German', ger: 'German', de: 'German',
  spa: 'Spanish', es: 'Spanish',
  ita: 'Italian', it: 'Italian',
  jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean',
  zho: 'Chinese', chi: 'Chinese', zh: 'Chinese',
  por: 'Portuguese', pt: 'Portuguese',
  rus: 'Russian', ru: 'Russian',
  nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
  pol: 'Polish', pl: 'Polish',
  swe: 'Swedish', sv: 'Swedish',
  dan: 'Danish', da: 'Danish',
  nor: 'Norwegian', no: 'Norwegian',
  fin: 'Finnish', fi: 'Finnish',
  ces: 'Czech', cze: 'Czech', cs: 'Czech',
  hun: 'Hungarian', hu: 'Hungarian',
  tur: 'Turkish', tr: 'Turkish',
  ara: 'Arabic', ar: 'Arabic',
  hin: 'Hindi', hi: 'Hindi',
  tha: 'Thai', th: 'Thai',
  heb: 'Hebrew', he: 'Hebrew',
  ell: 'Greek', gre: 'Greek', el: 'Greek',
  ron: 'Romanian', rum: 'Romanian', ro: 'Romanian',
  ukr: 'Ukrainian', uk: 'Ukrainian',
  ind: 'Indonesian', id: 'Indonesian',
  vie: 'Vietnamese', vi: 'Vietnamese',
  msa: 'Malay', may: 'Malay', ms: 'Malay',
};

export function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return LANGUAGES[code.toLowerCase()] ?? code.toUpperCase();
}

/** 8 channels is 7.1 to everyone except a spec sheet. */
function channelLayout(channels: number): string {
  if (channels === 8) return '7.1';
  if (channels === 6) return '5.1';
  if (channels === 2) return 'Stereo';
  if (channels === 1) return 'Mono';
  return `${channels}ch`;
}

/**
 * A commentary is the one track you must never select by accident, and the one you
 * sometimes want on purpose — so it is called out rather than left to be read out of a
 * sentence-long track name.
 */
export function isCommentary(track: { title?: string }): boolean {
  return /commentar|interview|isolated score/i.test(track.title ?? '');
}

/** Long disc-authored names are a paragraph; the list needs a line. */
function clamp(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function audioOptions(media: MediaFile | undefined): TrackOption[] {
  return (media?.audio ?? []).map((a, i) => {
    const lang = languageName(a.lang);
    const named = a.title && a.title.trim().length > 0 ? clamp(a.title.trim()) : undefined;

    // The codec and layout are the useful part when there is no name, and redundant
    // beside one like "TrueHD Atmos 7.1" — so the name wins when the disc supplied it.
    const label = named ?? [lang, a.codec, channelLayout(a.channels)].filter(Boolean).join(' · ');

    const detail = [
      named ? [a.codec, channelLayout(a.channels)].filter(Boolean).join(' ') : undefined,
      named && lang && !named.toLowerCase().includes(lang.toLowerCase()) ? lang : undefined,
      // Honest about what macOS will actually do with an object track — see §Audio.
      a.objectAudio ? 'decoded to PCM' : undefined,
    ].filter(Boolean) as string[];

    return {
      id: mpvTrackId(i),
      label,
      detail: detail.length ? detail.join(' · ') : undefined,
      isDefault: a.isDefault,
      isCommentary: isCommentary(a),
    };
  });
}

export function subtitleOptions(media: MediaFile | undefined): TrackOption[] {
  return (media?.subtitles ?? []).map((s, i) => {
    const lang = languageName(s.lang);
    const named = s.title && s.title.trim().length > 0 ? clamp(s.title.trim()) : undefined;

    // A name like "English (SDH)" is what distinguishes two otherwise identical
    // English tracks, so it is preferred over the language code it duplicates.
    const label = named ?? lang ?? s.format;

    const detail = [s.forced ? 'Forced' : undefined, s.format].filter(Boolean) as string[];

    return {
      id: mpvTrackId(i),
      label,
      detail: detail.join(' · '),
      isDefault: s.isDefault,
      isCommentary: false,
    };
  });
}

/**
 * Whether there is a decision to make.
 *
 * One audio track and no subtitles is not a choice, and a picker offering it is a
 * control that cannot change anything — the same rule the browse filters follow.
 */
export function hasTrackChoice(media: MediaFile | undefined): boolean {
  return (media?.audio?.length ?? 0) > 1 || (media?.subtitles?.length ?? 0) > 0;
}

export function trackOptionsFor(title: Title, versionIndex = 0): {
  audio: TrackOption[];
  subtitles: TrackOption[];
} {
  const media = title.media[versionIndex] ?? title.media[0];
  return { audio: audioOptions(media), subtitles: subtitleOptions(media) };
}

/**
 * Drop any remembered track this particular file does not have.
 *
 * A show's choice applies to every episode, and episodes are separate files — usually
 * with identical layouts, but not always. Asking mpv for `aid=3` on a file with two
 * audio tracks selects NO audio: silent playback in which the device, the channel
 * counts and everything else read healthy. So an id outside this file's range is
 * dropped, and the player decides as if nothing had been chosen. Subtitles "off" is
 * valid for every file.
 */
export function validTracksFor(
  choice: TrackChoice | undefined,
  media: Pick<MediaFile, 'audio' | 'subtitles'>,
): TrackChoice | undefined {
  if (!choice) return undefined;
  const out: TrackChoice = {};
  if (choice.audio !== undefined && choice.audio <= (media.audio?.length ?? 0)) {
    out.audio = choice.audio;
  }
  if (choice.subtitle === 'no') out.subtitle = 'no';
  else if (choice.subtitle !== undefined && choice.subtitle <= (media.subtitles?.length ?? 0)) {
    out.subtitle = choice.subtitle;
  }
  return out.audio === undefined && out.subtitle === undefined ? undefined : out;
}
