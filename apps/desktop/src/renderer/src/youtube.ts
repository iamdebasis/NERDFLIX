/**
 * The embed URL, in one place.
 *
 * Two surfaces build this now — the preview player that follows the pointer, and the
 * hero's billboard — and every parameter here is load-bearing for one reason or
 * another. Duplicating the list would mean fixing YouTube's next quirk twice and
 * forgetting one of them.
 */
export function youTubeEmbedUrl(
  id: string,
  opts: { muted: boolean; startAt?: number },
): string {
  const params = new URLSearchParams({
    autoplay: '1',
    // Chromium refuses to autoplay audible media, so playback always BEGINS muted.
    mute: opts.muted ? '1' : '0',
    controls: '0',
    rel: '0',
    iv_load_policy: '3',
    disablekb: '1',
    fs: '0',
    // Retained for older clients; YouTube has ignored it since 2023, which is part of
    // why the crop and the veils have to do this job instead.
    modestbranding: '1',
    playsinline: '1',
    // An ended video shows a grid of suggestions. Looping a single-item playlist is
    // the only way to never reach the end.
    loop: '1',
    playlist: id,
    enablejsapi: '1',
  });
  /*
   * Resume where we left off when a reload is forced.
   *
   * Nothing can ask YouTube to carry its position across a navigation, so when the
   * control channel is dead and mute or a resume costs a reload, this is what turns
   * "back to the beginning" into "roughly where I was". Whole seconds only — that is
   * all the parameter accepts.
   */
  const start = Math.floor(opts.startAt ?? 0);
  if (start > 0) params.set('start', String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}
