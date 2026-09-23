/**
 * When a film or an episode counts as watched.
 *
 * People close the player when the credits start. The old rule — the last 3% — sat
 * inside the credits of nearly everything: on the library this was measured against,
 * 11 of 15 films carry a chapter named for the end credits, and every one of those
 * starts between 93.0% and 96.4%. So a film closed at its credits stayed "in progress"
 * forever, and with no autoplay an episode closed at its credits made Play offer the
 * credits again instead of the next episode.
 *
 * A flat, earlier cut-off does not fix that either — Curse of the Black Pearl's
 * credits begin at 93.0% — and pushing it lower starts marking films finished before
 * their endings. The file usually knows where its credits are, so ask it first.
 */

/** Without a credits chapter: the final 5%. */
export const WATCHED_FRACTION = 0.95;

/** A credits chapter earlier than this is not the END credits of anything. */
const CREDITS_FROM_FRACTION = 0.8;

/** "End Credits", "Credits", "28. Credits", "Roads? (Credits)", "End Titles". */
const CREDITS = /\bcredits?\b|\bend[\s._-]+titles?\b/i;
/**
 * Not where the end credits begin: credits at the START ("Opening Credits"), and a
 * SCENE that plays during or after them ("Mid-Credits Scene", "Post-Credits").
 */
const NOT_END_CREDITS = /\b(opening|main|intro|beginning)\b|\b(mid|post|after)[\s._-]*credits?\b/i;

type Chapter = { title: string; startSec: number };

/** Where the end credits begin, when a chapter says so. */
export function creditsStartSec(
  chapters: readonly Chapter[],
  durationSec: number,
): number | null {
  if (!(durationSec > 0)) return null;
  const late = chapters.filter(
    (c) =>
      c.startSec >= durationSec * CREDITS_FROM_FRACTION &&
      c.startSec < durationSec &&
      CREDITS.test(c.title) &&
      !NOT_END_CREDITS.test(c.title),
  );
  // The FIRST: that is where the credits begin. A film with a mid-credits scene names
  // the credits again after it, and closing at the first is still closing at the end.
  return late.length ? Math.min(...late.map((c) => c.startSec)) : null;
}

/**
 * The position from which the file counts as watched: the start of its end credits
 * when a chapter marks them, and never later than the final 5% either way.
 */
export function watchedFromSec(durationSec: number, chapters: readonly Chapter[] = []): number {
  const byFraction = durationSec * WATCHED_FRACTION;
  const credits = creditsStartSec(chapters, durationSec);
  return credits === null ? byFraction : Math.min(credits, byFraction);
}
