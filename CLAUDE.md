# CLAUDE.md

Project instructions for coding agents. Read `ARCHITECTURE.md` before making structural
changes — it is the source of truth and contains a decision record explaining what was
already rejected and why.

## What this is

A local Netflix-style front end for a personal library of high-bitrate video files
(4K REMUX, 50–80 GB MKVs) on external SSDs and NAS shares. macOS, Apple Silicon.

## Hard rules — do not violate, do not "improve"

1. **Never use HTML5 `<video>` for library playback.** Chromium cannot demux Matroska and
   cannot decode DTS, DTS-HD MA, or TrueHD. Playback goes through mpv. The single
   exception is cached trailers in `cache/trailers/`, which we encode ourselves as
   H.264/AAC specifically so a video element can handle them.
2. **Never add on-the-fly transcoding.** This is a REMUX library; re-encoding defeats its
   purpose.
3. **Never take codecs, HDR, or audio layout from a filename.** ffprobe is authoritative
   for anything technical. Filenames are authoritative only for edition, source, and
   release group. TMDB is authoritative for narrative metadata. See ARCHITECTURE.md §5.3.
4. **Never hardcode a chip table, and never tune for one machine.** Hardware decode
   capability and GPU headroom vary across Apple Silicon generations and form factors —
   the same build must run well on a fanless laptop and a Mac Studio driving a Pro
   Display XDR. Measure at runtime: `hwdec-current` for decode (§2.1), GPU core count as
   an opening guess at a quality tier, and `frame-drop-count` as the authority that
   corrects it. See `packages/player/src/quality.ts` and `capabilities.ts`.
5. **Never pass an mpv option without checking it exists.** mpv exits on an unknown
   option. Filter every quality flag through `supportedOptions()` so a different
   Homebrew mpv version degrades instead of crashing.
6. **Never let the renderer touch `fs`, `path`, or `child_process`.** All disk access goes
   through typed IPC from the main process.
7. **Never re-match a title whose `matchState` is `confirmed`.** A rescan must not undo a
   user's correction.
8. **Never write to `state/` from a metadata operation.** `db/` is regenerable; `state/`
   holds watch history and must survive any rebuild.

## Layout

```
packages/core/   scanner, schema, volumes, metastore   (@nfl/core)
packages/cli/    scan, probe, doctor, add-title        (@nfl/cli)
apps/desktop/    Electron main + preload               (not built yet)
apps/ui/         React renderer                        (not built yet)
db/              title JSON — source of truth, agent-writable
state/           user state — app-owned, never regenerate
cache/           artwork, trailers, raw TMDB responses — disposable
```

## Commands

```bash
pnpm doctor                    # verify ffprobe / mpv / yt-dlp
pnpm scan <path>               # scan a library root, print a report
pnpm scan <path> --fast        # skip ffprobe, structural pass only
pnpm scan <path> --json        # machine-readable output
pnpm test                      # regression suite
pnpm typecheck
```

## Code conventions

- ESM only. `type: module` everywhere. Import with explicit `.js` extensions in TS source
  (NodeNext resolution).
- TypeScript strict. No `any` in exported signatures.
- Zod schemas define the shape of anything that crosses a process or file boundary.
- Comments explain *why*, not *what*. Anything non-obvious gets a pointer to the relevant
  ARCHITECTURE.md section.

## Current state

Everything below is built, verified against real hardware and real files, and should be
left alone unless a specific fault is found. The detailed sections further down explain
WHY each piece is the way it is — read the relevant one before changing it, because most
of these settings were arrived at by measuring something that contradicted the obvious
guess.

**Working end to end:**

- **Scanner** — both release shapes, junk and sample filtering, `.nfo` IMDb ids,
  ffprobe. Content-addressed identity (see §"Identity comes from content").
- **Player** — long-lived external mpv over JSON IPC. HDR passthrough, hardware decode,
  adaptive quality that moves in BOTH directions, verified status reporting.
- **Data** — Zod schemas, per-title JSON, state kept separate and never regenerated,
  volume pairing with UUID relocation, availability resolution.
- **Enrichment** — TMDB matching and artwork, triggered automatically after a scan.
- **UI** — library picker with per-drive and combined cards, Netflix-style browse with
  hero, rows, hover cards and detail modal, search across title/year/genre/director/cast,
  My List, Continue Watching with progress bars.
- **No required terminal commands.** `pnpm install` then `pnpm app` is the whole surface.

**Test suite:** 134 tests. `pnpm test` covers `packages/*` AND `apps/desktop/src/main`.
The desktop tests were silently excluded for a long time — do not narrow that glob again.

## Open threads

**1. HDR — settled: IINA renders, we keep everything else.**

Five mpv configurations were measured against IINA on an XDR MacBook Pro and none
closed the gap: HDR passthrough signalling, `--target-peak=1600`, MoltenVK via
`--gpu-context=macvk`, mpv's native Swift/Metal `cocoa-cb` backend, and explicit
`--target-trc=pq --target-prim=bt.2020`. Do not reopen this by trying more flags.

The difference is architectural. IINA hosts libmpv and draws frames itself, so it owns
the `CAMetalLayer` and sets `wantsExtendedDynamicRangeContent` directly. A standalone
mpv process can only ask the compositor for EDR headroom indirectly, and on macOS that
is demonstrably weaker.

So `IinaEngine` (packages/player/src/iina.ts) launches films through `iina-cli` and
drives them over the same JSON IPC — because underneath, IINA IS mpv. Resume tracking,
verified status reporting and quality adaptation all keep working; only rendering is
delegated. IINA is used automatically when installed, mpv otherwise. `NFL_PLAYER=mpv`
forces the old path, `NFL_PLAYER=iina` makes a missing IINA an error.

Audio routing belongs to IINA on that path: the status line reports what IINA actually
did (e.g. `dts 6ch → 2ch via coreaudio`), which may differ from what bare mpv chose for
the same file. That is IINA's configuration, not a fault, and not ours to override.

`readPlaybackStatus(engine, { renderer: 'host' })` for IINA. The HDR verdict is
renderer-dependent: with bare mpv, `--target-colorspace-hint=yes` is how the display
learns the content is PQ, so its absence means tone-mapping. IINA drives the
CAMetalLayer itself and needs no such hint — requiring it reported "tone-mapped to SDR"
over demonstrably working HDR. mpv's `target-peak` is likewise meaningless there.

`IinaEngine.load()` waits for the FILE to be open, not just the socket: the socket
appears when IINA's mpv starts, which can be before it has opened anything, and reading
then reports a blank player (0x0, no codec, "audio device did not open") as fact.
`readPlaybackStatus` retries for the same reason — properties populate asynchronously,
retrying is cheap, printing a confident lie is not.

THE ONE MANUAL STEP, and it cannot be avoided: `iina-cli` deliberately ignores
`--input-*`, so the IPC socket cannot be passed per launch. The user must set
`input-ipc-server=/tmp/nerdflix-iina.sock` once in IINA → Settings → Advanced →
Additional mpv options. Without it the engine refuses to start rather than silently
losing watch history, and the error message says exactly what to paste.

**2. Playback happens in mpv's own window, not inside the app.** Settled deliberately —
see §"Playback: mpv owns its own window" for the three structural reasons a transparent
overlay cannot work. The only correct fix is libmpv rendering inside Chromium via a
native addon (`electron-mpv-video`). Do not rebuild the overlay.

**3. Not built, in rough priority order:** trailers (yt-dlp cache), scrub-preview
thumbnails (needs the thumbfast pattern — a second hidden mpv instance; a pre-generated
sprite sheet is impossible on an 80 GB file), Skip Intro from chapter markers, a review
queue for titles TMDB matched wrongly, and the derived SQLite index (deliberately
deferred — it is disposable, and a few hundred titles resolve in memory instantly).

## Working with the user on this project

They test everything on real hardware and send screenshots. That has caught many bugs no
amount of reasoning would have. Corollaries learned the hard way:

- **Verify on THEIR machine, not this sandbox.** An mpv version was once read from the
  container and reported as theirs; it was three releases stale and the diagnosis was
  wrong. Ask for `pnpm doctor` output instead.
- **Screenshots of HDR content are not evidence about the screen.** PQ captured into an
  SDR screenshot always looks dark and desaturated, whatever the player is doing.
- **Drive the real UI before claiming a UI fix works.** Several "correct" changes were
  wrong in ways only a rendered frame showed.
- Never write `...` inside a runnable command; it gets pasted literally.


## Secrets

`.env` is read from the data directory FIRST, then the repo, and a repo copy is
persisted to the data directory on first use. `.env` is never in a distributed archive
(it holds a secret), so a token kept only in the repo is lost on every update and the
failure reads as "TMDB_READ_TOKEN is not set" immediately after setting it. The error
lists every path checked and what it found there — keep it that way.

## Enrichment

`pnpm enrich` needs `TMDB_READ_TOKEN` in `.env` (gitignored). One `append_to_response`
request per title pulls credits, videos, images, release dates and external ids
together. Raw responses are cached verbatim in `cache/tmdb/` so a schema change can
re-derive every record with no network AND no re-matching — a title that matched
correctly once must never silently match differently later.

Matching lives in `enrich/match.ts` and is pure and tested. Auto-accept requires title
AND year to be convincing AND a clear gap to the runner-up; a near-tie is the remake
case and goes to review. Runtime from ffprobe corroborates but never overrules, because
an alternate cut is still the same film. `runtimeMinutes` stays ffprobe's — it describes
the file on disk, not TMDB's canonical cut.

## Collections and re-deriving

TMDB's `belongs_to_collection` was already in every cached response and was simply
being dropped — a franchise row costs no network at all.

Two or more OWNED members make a row (`MIN_ROW`). One film is not a collection, and a
"Cars Collection" row over a single Cars is worse than no row. Members are in RELEASE
order, because that is how a series is watched, and the row sits above genres because
"Star Wars Collection" says more about a shelf than "Science Fiction" does.

**Adding a derived field must not re-match anything.** `DERIVE_VERSION` stamps each
record with the derivation that wrote it, and a title carrying an older stamp is
re-derived from `cache/tmdb/<id>.json` — details only, no search, so a title that
matched correctly once cannot silently match differently later (§7.4). Artwork and
`matchState` are left untouched, which is what makes it safe to re-derive a `confirmed`
title: re-deriving is not re-matching. Verified by running `pnpm run enrich` with a
deliberately INVALID token — 11 of 14 titles re-derived cleanly and only the three still
in `review` reached for the network and failed. Bump `DERIVE_VERSION` whenever
`applyDetails` learns to read something new; that is the whole backfill mechanism.

`needsEnrichment` is the single rule both callers pre-filter with. They had two
different filters that had already drifted — the CLI tested `overview`, the app tested
`overview` AND `artwork.poster` — and neither agreed with the gate inside `enrichTitle`,
so the app queued titles it would then skip and the CLI never reached the re-derive
branch at all. A caller-side filter that disagrees with the callee's gate is how a
backfill silently does nothing.

Row assembly is pure, in `apps/desktop/src/main/rows.ts`, because ordering is its entire
substance and none of it is visible in a screenshot. Equal-sized rows break ties by
NAME rather than relying on sort stability: the old inline version ordered genres by
count alone, so two equally common genres came out in whatever order the library
happened to load in.

## Sort and filter

One control in the nav, not a strip beneath it: a permanent row of pills would push the
hero down on every launch to serve something used occasionally. A closed panel cannot
say what is on, so the button carries a badge counting active FACETS — not values, or
picking three genres would read as three filters.

**Narrowing collapses the shelf into one set, exactly as search does**, and for the
same reason: the same film under "Action", "Science Fiction" and "Recently Added" reads
as three results. A SORT narrows on its own — asking for the library in title order and
getting genre rows each internally sorted is not what was asked for.

Search, view and filters COMPOSE rather than override: the view picks the base set,
search narrows it, filters narrow it again, and only a narrowed set is re-ordered. My
List keeps the order things were added in and search keeps the library's, which is what
each of them meant before. The empty state names whichever is responsible — blaming the
search for a result the FILTER excluded sends you off retyping a query that was never
the problem.

**A facet is offered only when it SPLITS the library** (`splits` in
`browse-filter.ts`). One rule behind all of them: a control matching everything, or
nothing, cannot change what you see, and pressing it while nothing moves looks like a
bug. On the real library this withholds the whole "Show" section — nothing is watched
and every drive is connected — which is the rule proving itself rather than a gap.

**A result set is a GRID; a shelf is a row.** Browsing is rows because a shelf is a
slice of the library and its length is not the point. A result's size IS the point, and
twelve results in a horizontal strip leave four fifths of the page black. Posters come
out larger in the grid because the columns divide the full width; that is deliberate.
`auto-fill`, never `auto-fit` — `auto-fit` stretches a two-result grid across the whole
window, which reads as a rendering fault.

The grid is the EASIER layout for the hover card, not a risk to it: `.row-scroller` is
`scroll-snap-type: x proximity` and a scaling `.tile:hover` makes the browser re-snap
and fire a scroll event with nothing having moved. A grid neither scrolls horizontally
nor snaps, so that class of flicker cannot arise.

Title order uses the scanner's `sortTitle`, surfaced on the card, so "The Dark Knight
Rises" files under D rather than T. Known quirk, left alone: scene names spell episodes
in Roman numerals, so A–Z gives I, II, III, IV, IX, V, VI. Parsing numerals out of a
filename is exactly the cleverness rule 3 forbids, and release order already exists
where it matters — the collection row.

Every control in the panel lives inside `.nav`, which is a window drag region, so they
depend on the blanket `.nav button` no-drag rule. Verify these with a REAL mouse event
(`Input.dispatchMouseEvent`) — `element.click()` ignores `-webkit-app-region` entirely
and will pass against a control that is dead to an actual pointer.

## No required terminal commands

`pnpm install` then `pnpm app` is the entire user-facing surface. Adding a library,
scanning, rescanning, pruning and enrichment are ALL reachable from the picker, and
scanning chains straight into enrichment. The CLI still exists for debugging, but
nothing should ever *require* it — if a new capability lands, it needs a UI path too.

The TMDB token is set IN THE APP, not by editing a dotfile. `.env.example` is a
template that is never loaded, and putting a token there looks exactly like the app
being broken. `loadEnvFiles(dataDir, projectRoot)` — passing the data dir twice was a
real bug that made a token in the project root invisible.

## Buttons

One sizing system, in `.circle` / `.circle.big` / `.play-button` / `.info-button`, and
icons are DRAWN (inline SVG), never typed. They were text glyphs — ▶ ✓ + ⌄ ✕ ⓘ — which
sit on a text baseline rather than in the middle of their button, take their weight from
whatever font resolves, and change size with the font stack.

Icon size is declared by the CONTROL, not per button. It used to be per button, which is
how the modal's mute button ended up with an unconstrained SVG spilling out of its
circle: it is a `.circle big`, but the rule sizing the icon was scoped to
`.trailer-sound`. Sizing from the control means a new button cannot be born broken.

The modal's action row, its close button and the metadata column all share one right
gutter (`3rem`), and every control in the row is the same height, so they sit on a
single baseline.

## Progress bars

`resumePct` is computed in the MAIN process, where both the position and the true
duration are known, and sent on the card. Never re-derive it in the renderer from
`runtimeMinutes`: that is a proxy — whole minutes, absent until a title is enriched,
and 0 for anything short — and the bar's truthiness check treated 0 as "no progress",
so it silently vanished instead of showing 0%.

`null` means no progress and hides the bar; 0 would draw an empty track on every
unwatched film.

## Trailers

TMDB's `videos` were already fetched and a trailer already stored on each title during
enrichment — it was simply never surfaced. `TitleCard.trailerUrl` exposes it.

A YouTube iframe, not a `<video>` tag: YouTube serves no raw MP4 to point one at, and
resolving a direct stream with yt-dlp costs seconds per card, yields expiring URLs and
breaks whenever YouTube changes. Nothing is downloaded either way.

Three rules, each of which silently breaks the feature:
- **`mute=1`.** Chromium refuses to autoplay audible media. Without it nothing plays.
- **UNMOUNT on leave, never hide.** A hidden iframe keeps buffering, so sweeping a row
  would leave a trail of players pulling video.
- **Delay the mount** past the hover-intent delay, or crossing a row fires a dozen
  YouTube loads for cards nobody looked at.

The backdrop stays mounted underneath as the fallback for not-yet-loaded, no-trailer and
offline.

ONE player for the whole app (`TrailerHost`), mounted once at the document root,
fixed-positioned, animated to the box of whichever surface claims it via
`useTrailerTarget`. Do NOT render an iframe per surface: that restarts the video when
the mute button changes a URL parameter, and again when a hover card expands into the
modal, because that is a different component and therefore a different iframe. An
iframe cannot be moved in the DOM either — React portals and manual `appendChild` both
reload it. Surfaces claim the player with the TITLE ID as key, so hover → modal is a
move rather than a reload.

The host's z-index is per-surface, and which side of the video a surface sits on is
the single most important thing to understand here.

- **Hover card — player ABOVE (95).** The card is at 60. The host sat at 60 too, tying
  with it and losing to `.modal-scrim` at 80, so the player rendered perfectly while
  being painted over by the very card it was meant to fill. Because the player is on
  top here, the host draws the mute button itself.
- **Modal — player BELOW (75).** `.modal-dim` at 70 carries the page wash, the player
  sits at 75, `.modal-scrim` at 80 is transparent and only scrolls and closes, and
  `.modal` itself has NO background — `.modal-panel` carries it. Everything inside the
  dialog therefore paints over the video for free: logo, Resume, progress, mute.

That inversion is what replaced the old arrangement, where a fixed sibling could not be
above the modal's backdrop and below its text at once, so the hero body sat BELOW the
picture and the modal read as a video with a caption under it rather than a detail
page. If you change the modal's background back to opaque, or put the wash back on the
scrim, the trailer disappears behind the dialog and the symptom looks like the player
failing to load.

**The release is DEFERRED, and that is what makes hover → modal a move.**
`releaseTrailerSoon` (packages the player's ownership in `trailer-store.ts`) waits
120ms before letting go. Releasing on the spot looks safe, and the old code even
guarded it with "release only if still ours" — but the guard cannot help, because at
that instant it IS still ours. React runs an unmounting component's cleanup BEFORE the
newly mounted one's effect, and the modal's effect only starts a frame loop; it does
not claim until the next frame. The target went null for one frame, the host rendered
nothing, the iframe was destroyed, and the modal mounted a fresh one — a fresh load,
back to zero after a minute of watching. Whoever claims inside the grace wins; the
pending release then finds the player no longer its own and does nothing.

The ownership rules live in `trailer-store.ts`, React-free, because every bug in them
has been about ORDERING rather than rendering — invisible in a screenshot, and
`trailer-store.test.ts` holds them still. If you change the release, check that
"the player is never unowned during a handover" still fails when you make it
synchronous; a regression test that passes either way is worth nothing.

**Entitlement to release is a TOKEN, not an identity.** The obvious guard — "release
only if the current owner is still the one I was scheduled for" — compares key and
surface, and StrictMode defeats it. React runs every effect twice in development
(setup, cleanup, setup), so a modal mounting schedules a release for ITSELF between its
two mounts and then re-claims under exactly the identity that release was waiting for.
The guard says yes and destroys the live player. `claimSeq` is bumped by every real
claim; a pending release fires only if nothing has claimed since. The frame loop's
identical re-claims return early without bumping, so ordinary dismissals still land on
time. NOTE this symptom is development-only — a packaged build does not double-invoke —
but `pnpm app` is how this project is actually run.

`.modal-hero-plate` is the still backdrop and fades out once the trailer is up
(`useTrailerVisible`), because anything opaque inside the hero covers the video behind
it.

The frame is sized in JS, not CSS: `coverFrame` solves for a true 16:9 box that COVERS
the surface, because the surface is not 16:9 and a percentage-sized iframe letterboxes
inside it.

**The two edges are cropped by different measures, and this is not an inconsistency.**

- **Top — `OVERSCAN_TOP_PX` (44px, fixed).** It carries YouTube's title bar, which is
  drawn at roughly the same size whatever the player's size. A percentage here
  under-crops a small hover card and throws away picture on a large modal, which is
  what `132%` did.
- **Bottom — `OVERSCAN_BOTTOM_RATIO` (10%, proportional).** It carries whatever the
  trailer burned into itself, chiefly subtitles, and those are authored as a share of
  the picture. Using the pixel constant here cleared them on the 320px hover card and
  left them showing through the gradient on the modal, where 44px is about 7% of the
  frame. Reported as "faded subtitles below the video frame, in the bigger popup" —
  and the fact that it was ONLY the bigger popup is the whole diagnosis.

`frameOffsetY` shifts the frame so each edge gives up its own amount, clamped so an
edge of the box can never be left uncovered.

**What is NOT fixable this way:** a scope trailer (2.39:1) is letterboxed inside its own
16:9 YouTube frame, so part of that black bar survives the top crop. The source aspect
cannot be measured — reading pixels from a cross-origin iframe is not possible — and
cropping enough to clear it would gut a 16:9 trailer. The top veil makes the remainder
read as vignette.

The position transition is armed ONLY during a handover (`.is-moving`). Left permanent,
it also applied to the per-frame scroll tracking, so the video eased 260ms behind the
page and read as a separate floating object.

YouTube's centred transport controls show for the first seconds of every embed and
cannot be cropped (they are not at the edges) or detected (postMessage needs a real
origin; a packaged renderer is `file://`). `REVEAL_SETTLE_MS` waits them out — measured
here as still present at ~1.2s after load, gone by 5s.

Mute tries postMessage first and only reloads if the channel is dead. Whether it is
alive is detected by receiving ANY message from the player; nothing depends on that
working, it only decides whether mute costs a restart.

DO NOT gate the reveal on YouTube's `enablejsapi` postMessage events. It was tried and
the loader ran forever: that protocol needs a real page origin to post back to, and a
packaged Electron renderer is loaded from `file://`, whose origin is null. Nothing ever
arrives. The reveal uses the iframe's own `load` event, which DOES fire cross-origin,
plus a 700ms settle so the cut does not land on a black frame.

For the same reason, mute is toggled by REMOUNTING the frame with a different `mute`
parameter rather than by postMessage. That restarts the trailer — a second of cost on a
deliberate, occasional click, in exchange for working in a packaged build at all.

The cost of load-gating: a blocked host renders the browser's error page inside the
frame and `load` still fires, so it is briefly visible. `navigator.onLine` covers the
offline case; "online but YouTube unreachable" is rare and cosmetic, and the
alternative was a feature that never worked.

Hiding YouTube's chrome takes three things, because `controls=0` leaves the watermark,
the title bar and the end-screen grid:
1. `pointer-events: none` on the iframe — most overlay chrome only appears on hover, so
   a player that never sees a pointer never draws it.
2. Scale the frame to 132% and crop — the watermark lives at the edges.
3. `loop=1` with a single-item `playlist` — an ended video shows suggestions.

Control uses YouTube's postMessage protocol with `enablejsapi=1`, NOT their IFrame API
script: same capability, no third-party JavaScript, no `script-src` in our CSP. The
`listening` handshake must repeat until the first event lands, because one sent before
the frame is ready is simply lost.

CSP needs `frame-src https://www.youtube-nocookie.com`.

## The hero billboard

The hero's artwork comes to life `HERO_SETTLE_MS` (5s) after you arrive — long enough
that the page is a still image first, so the motion is a reward rather than a surprise.

**It rotates through "Recently Added", in that row's order, advancing each time a
trailer has been round once.** It replaced a rule that was not a selection at all: the
first title `readdir` happened to return that had artwork — which meant the same film
every launch, forever, ordered by the filesystem rather than by intent. Titles with no
backdrop are skipped, because a hero without artwork is a blank rectangle with text on
it; that filter is the one part of the old rule worth keeping.

Finishing is detected as the loop WRAPPING, not as an end event, and `didTrailerLoop`
is where that lives. The embed keeps `loop=1` because an ended YouTube video shows a
grid of suggested thumbnails — the billboard would be advertising someone else's
videos. Looping means the end is never reached, so the signal is the playhead jumping
backwards from near the end. Two details that each broke it:

- **The landing point is not zero.** Reports arrive a few times a second and the first
  one after a restart is routinely a second or three in, so testing for "back to the
  start" missed the wrap entirely and the billboard never advanced.
- **Only listen to OUR OWN frame** (`e.source === frameRef.current?.contentWindow`).
  The preview player is a second YouTube embed reporting its own `currentTime` to the
  same window. Observed live: reports alternating between 62s and 3s, so an ordinary
  pair looked like a wrap and handed the billboard on early.

When nothing will report an ending, two dwell timers keep the rotation moving rather
than stalling on one film: `HERO_NO_TRAILER_DWELL_MS` for a title with no trailer at
all, and the generous `HERO_FALLBACK_DWELL_MS` when the player will not talk to us
(a packaged renderer is `file://`, whose origin is null). Both stop while the billboard
is paused, so time spent scrolled away is not charged to the film you are about to
look at.

**The hand-over is a sequence, not a cut.** Artwork holds for `HERO_SETTLE_MS` (5s),
the trailer plays, and when it wraps the billboard returns to the SAME film's still for
`HERO_OUTRO_MS` (2s) before crossing to the next. Cutting from a moving frame straight
into a different film reads as a glitch — two unrelated images with nothing between
them. Landing back on the still it started from closes the loop and gives the dissolve
something calm to begin from. Measured live: 2.1s outro, 1.0s dissolve, 5.1s settle,
1.7s reveal.

`outro` is a phase in `heroTrailerVerdict`, not a timer bolted on: the frame STAYS and
is paused, because tearing it down for the two seconds before it is discarded anyway
would cost a reload, and a frame vanishing mid-fade is the flicker the phase exists to
prevent.

The dissolve needs the OUTGOING artwork to survive the swap (`.hero-outgoing` in
Browse), because the hero layer remounts on the new title — fading it in alone would
reveal the page background rather than the previous film. Two things this depends on:

- **`.hero` owns the dark floor, `.hero-trailer` is transparent.** The background used
  to sit on the trailer layer, which made it opaque, so the film being dissolved FROM
  was painted over before it could show.
- **The dissolve timer lives in a REF, never in the effect's cleanup.** That effect runs
  after every render by design (the hero is derived during render, so the comparison has
  to happen on every commit). Returning `clearTimeout` from it cancelled the timer on
  the very next render — the one `setOutgoingArt` had just caused. Measured: the
  outgoing layer still mounted seven seconds into a 900ms dissolve, and stale by the
  time the next hand-over began.

A detail dialog over the billboard counts as covered and pauses it, same as scrolling
away — it should not play to a surface nobody can see.

**`HeroTrailer` and `.hero-body` are siblings and MUST NOT share a key.** Both are keyed
on the title so they swap together, and using the bare id for both made React unable to
match children across a rotation: each new billboard was mounted WITHOUT the old one
being unmounted. Three players stacked inside one hero after two handovers, all still
streaming, and nothing looked wrong because the newest paints on top. React says it out
loud — "Encountered two children with the same key... may cause children to be
duplicated" — so a duplicate-key error in the console is never cosmetic here. Measured
after the fix: one layer, one frame, one mute button, still, after a handover. `.hero-body` is keyed on the
title id so the logo and blurb arrive rather than snapping when the rotation turns.

**It is a SECOND player, and that does not contradict "one player for the whole app".**
That rule exists for the preview that FOLLOWS THE POINTER: hover card and detail modal
are two components showing the same film, and an iframe in each meant the video
restarted every time it moved between them. The billboard never moves, is never the
same element as the preview, and is tied to one title for as long as the page shows it.
Sharing the pointer's player with it would mean the billboard stopping dead every time
you hovered a poster — visibly worse than not having it.

It is also much simpler than the preview player, for one structural reason: it is a
CHILD of `.hero` rather than a fixed element at the document root. No position
tracking, no clipping, no z-index inversion — the gradient and the title block are
later siblings and paint over it for free.

**`.hero-trailer` must keep `z-index: 0`.** That makes it a stacking context and seals
its children below the title block. Without it the shield inside (z-index 3, and it has
to be) competed with `.hero-body` at 2 and won — the hero's Play and More Info buttons
were covered by a transparent sheet and silently stopped working. The mute button is
therefore rendered OUTSIDE that layer: inside it, `.hero-fade` painted over it exactly
where the gradient is strongest and it came out muddy.

`heroTrailerVerdict` decides mount and play separately, and the split is the design:

- **Terminal** (no trailer, a film playing, offline, still settling) → the frame goes.
- **A pause** (scrolled away, window hidden) → the frame STAYS and is paused, so coming
  back picks up mid-sentence. Only if the player will not take a pause command does the
  frame have to go, and then `start=` makes the reload nearly invisible.

**Keep saying `listening` for the life of the frame, not just until it answers.**
YouTube streams `infoDelivery` — the messages carrying `currentTime` — only while it is
being listened to. Stopping the handshake on the first reply froze the remembered
position near zero, so a forced reload would have resumed at the beginning after all.
Verified live: paused for 6s the position advanced 0.1s, and resuming carried on from
where it stopped rather than restarting.

Mute goes through that same channel, so it costs no reload. The `file://` fallback
(a packaged build has a null origin and never gets a reply) reloads with `start=` at
the remembered position.

## Starting a film does not close this window

mpv and IINA play in their own window, so clicking Play leaves the browse surface
exactly where it was — and the trailer carried on with its own audio over the top of
the film that had just started. Two things happen, in this order, and the order is the
point:

1. **`suspendTrailer()` fires on the click.** Waiting for the engine to resolve leaves a
   second or two of trailer audio over the opening of the film.
2. **The surface is dismissed only once the film is genuinely running.** IINA can take a
   moment to launch; a modal that vanishes instantly leaves you on the browse grid
   wondering whether the click registered. The Play button shows `Starting…` with a
   spinner meanwhile. If playback FAILS the surface stays put and says why — that is
   the only moment the context is still useful — and the trailer resumes, because
   nothing is playing for it to talk over.

Releasing the target is not enough on its own: the surface's frame loop re-claims it on
the very next tick, so `suspended` is a latch. It is cleared the next time a surface
attaches, which only happens when someone hovers a new tile or opens a detail view.

**The attach loop is `requestAnimationFrame`, and Chromium pauses that entirely for a
hidden window** — measured as zero frames in three seconds while timers kept ticking. So
a minimised window can never attach the player, but one already playing kept going,
audible, out of a window nobody could see. `visibilitychange` suspends and resumes for
exactly that. It is also worth knowing when debugging: if the trailer never appears,
check whether the window is actually on screen before looking anywhere else.

Not handled, and a judgement call rather than an oversight: hovering a tile WHILE a film
is playing will start a trailer. The renderer has no signal for "a film is playing" —
adding one means a new IPC channel — and Netflix sidesteps it by navigating away, which
this app cannot do.

## Navigation

The nav answers "where am I", "what can I see", and "how do I get out".

- The nav is a window drag region, so EVERY interactive child needs
  `-webkit-app-region: no-drag` or clicking it drags the window instead. One rule
  covers `button`, `input`, `a` and `[role=button]` inside `.nav`, so anything added
  later works without remembering this. Search and both tabs were dead because only
  `.brand` was excepted.
- The NERDFLIX wordmark identifies the app and does NOTHING else. It is a supplied
  image asset (`renderer/src/assets/nerdflix.png`), stored cut out to transparency so
  it sits over the nav gradient and the hero behind it. `Wordmark.tsx` sizes it by
  HEIGHT alone, so a layout change cannot stretch it.

  Two generated versions preceded it — set in a typeface, then drawn as glyph paths —
  and neither matched a mark someone actually designed. Logos are artwork; ship the
  artwork. If it is ever replaced, cut the new one out to alpha the same way rather
  than compositing a dark background, or it will show a box over the hero. It is original letterforms in the same
  visual family, not a copy: the Netflix mark is a trademark and Netflix Sans is
  proprietary.
- Beside it, the LIBRARY NAME with a back chevron — a separate control, never the logo. It was "▸ LOCAL": a brand
  that happened to be the only exit, so nobody would think to click it, and which never
  said whether you were in one drive or all of them.
- **Browse** and **My List** are real views with an active state. They were inert
  `<span>`s — UI that looks like navigation and does nothing is worse than none.
- **Search** covers title, year, genre, director and cast. It collapses everything into
  ONE results row rather than filtering each row in place: the same film appearing under
  Action, Crime and Recently Added reads as three results.
- The hero is hidden in filtered views — over search results it is a large picture of
  something you did not ask for. `rows-bare` then removes the negative offset that
  normally tucks rows under the hero, or the first row title hides behind the nav.
- Empty states say what happened AND what to do. A blank page is not an answer.

## The picker does not move while it works

Scanning, finishing, fetching artwork and failing were four separate conditional blocks
stacked in a centred column, so every appearance and disappearance re-centred the page
and the cards jumped. They are now ONE `.picker-status` region with its height
reserved, holding a single exclusive state — error > live progress > finished result —
that cross-fades. Measured on a real scan: the card row and the actions row both move
**0px** across the whole cycle.

Three details that each caused a visible jump on their own:

- **`.picker-row` stretches, and `.scan-button` is `margin-top: auto`.** The combined
  card carries a line the others do not ("N films on two drives, counted once"), so with
  `align-items: flex-start` its Rescan button sat lower than the rest, and the row grew
  and shrank as that line came and went after a scan.
- **`.scan-button` has a `min-width` and tabular figures.** Its label changes while you
  watch it — Rescan → Reading… → 0/12 → 10/12 → Saving… — and without both the button
  resizes on nearly every tick.
- **The live filename is one ellipsised line.** A name changing length several times a
  second reflows everything under it otherwise.

The scan state is set optimistically on click rather than waiting for the first progress
event, or the region blinks empty for a beat first. Progress shows a bar, which carries
the movement so the numbers do not have to, and sweeps indeterminately until the walk
has counted the files — `0/0` is a meaningless fraction to greet a click with.

## The combined "All films" card

Shown only when more than one library is paired, first in the row, browsing every
library at once (`ALL_LIBRARIES` → no volume filter in buildBrowseData).

Its counts are DEDUPLICATED, and this is the whole reason it needs care. Content
addressing means a film copied between drives is ONE title with two sightings, so
adding the per-drive numbers overstates the library — 3 + 2 drives is 4 films, not 5.
Bytes count the largest copy of each film: the volume of distinct content, not of disk
consumed. Where duplicates exist the card says so, because a number that silently
disagrees with the two beside it looks like a bug.

Its face is one shelf whose spines take their hues from every contributing library.
Stacking clipped shelf strips was tried and read as coloured blocks; a combined library
is genuinely one shelf holding everything.

## Nested folders are scanned, not skipped

Pairing a drive finds films at ANY depth. Discovery recurses; see ARCHITECTURE.md §7.1
for the algorithm and `discover.test.ts` for the cases.

It used to stop at one level, and a folder holding more than one feature was recorded
as a `multiple-features` issue and skipped whole. "Star Wars Collection" with eight
films in it therefore contributed nothing to its parent library — pairing MOVIEX
reported 4 films where there were 12 — and the only way to see them was to pair the
subfolder separately. Verified on the real drive after the fix: 12 films, 0 needing
review.

Three things keep that from over-reaching, and none of them is optional:

- **A release folder needs one feature DIRECTLY inside, whose name the folder
  describes** (`folderDescribesFile`). Counting files is not enough:
  `1980s/Sci-Fi/Ridley Scott/Blade.Runner.mkv` made a film called *1980s* without the
  depth test, and *Ridley Scott* without the name test.
- **`looksLikeMultiPart` is deliberately narrow.** `Movie.CD1` / `Movie.CD2` is one
  film and stays a review issue. Names must be identical apart from the part marker, so
  sequels and different films in one folder are never mistaken for parts.
- **Depth is capped and directories are visited once by inode.** A symlink loop on a
  NAS share would otherwise walk forever, and a scan that never finishes looks exactly
  like a scan that crashed.

`Subs/` was in ARCHITECTURE's junk list but never in `JUNK_DIRS`, so a subtitle folder
containing a stray video counted as a second feature. Fixed; if you add a junk
directory to one, add it to the other.

## Drive contents changing

`pnpm scan`, or the Scan/Rescan button on a library card. The button lives OUTSIDE the
card element deliberately — nesting a button inside a button means a near-miss opens
the library instead of scanning, and it is invalid HTML.

Three cases, handled differently on purpose:
- **Added** — picked up normally.
- **Renamed** — matched by fingerprint (size + mtime, identical across a rename) and
  the existing record's path is updated. Without this a rename looks like a new file
  plus a missing one, creating a duplicate and orphaning the original's TMDB match,
  artwork and confirmed status.
- **Deleted** — reported, never acted on. Scanning must not destroy metadata as a side
  effect: "the file is missing" can mean a half-finished copy or a drive that mounted
  oddly. `--prune`, or the button in the UI, does the removal.

Watch history lives in `state/` and survives pruning, so re-adding a film restores its
resume point.

## Playback: mpv owns its own window

mpv plays in its own window with its own OSC, keybindings and fullscreen
(`ownControls: true`). This is a settled decision, not a placeholder — do not
reintroduce a transparent overlay window.

A transparent Electron window floating over a borderless mpv window was built and
abandoned. Two windows in two processes cannot be kept in agreement on macOS:

- Their sizes drift. Electron reports display bounds in points, mpv's geometry is in
  pixels, and mpv resizes itself to the video's aspect ratio on top of that.
- Clicking the video focuses mpv — a different application — so our app backgrounds
  while an always-on-top overlay stays pinned over whatever you switch to.
- Hiding the overlay to fix that traps it permanently: the hidden overlay exposes
  mpv's window, clicking it activates mpv, and `activate` never fires for an app the
  user never clicked.

Each fix exposed the next problem. Netflix avoids all of it with ONE window — video,
letterbox and controls are the same surface, so they cannot desync. Matching that
requires libmpv rendering inside Chromium's pipeline via a native addon
(`electron-mpv-video` does this; macOS arm64, Electron 40+). That is the only correct
fix if the current arrangement stops being good enough. Patching two windows is not.

Playback quality is identical either way — this is purely about who draws the chrome.

Window settings, each for a reason:
- `--border=yes` and NOT `--fullscreen`. The title bar carries the close button; native
  fullscreen hides it and leaves `q` as the only way out, which nobody discovers. The
  green button or `f` gives fullscreen when wanted.
- `--autofit=92%x92%` + `--geometry=50%:50%` — a large centred window. Percentages, so
  it lands correctly on any display without unit arithmetic.
- `--osd-bar=no`. The OSD bar is the seek/volume feedback strip, separate from the OSC.
  It draws with mpv's bundled symbol font and renders as a white zigzag when that font
  does not resolve. The OSC already shows position and volume.
- `--force-media-title` AND `--title` — the library's title in both the OSC and the
  window title bar, rather than the scene filename.

## Hover card and row reflow

Rows appear and disappear as a side effect of actions — adding the first My List item
creates that row, removing the last destroys it. Every row below then moves while the
hover card stays pinned to a screen position, so unrelated posters slide in beside it
and it reads as though the click added them. It was reported twice as a broken
add/remove; the data was correct both times.

`toggleList` compares the row set before and after and dismisses the hover card when it
changed. Do not try to re-anchor the card instead: the tile the user was pointing at has
genuinely moved, and a card that silently re-targets is worse than one that closes.

**Dismissal is by POINTER POSITION, not by `mouseleave`.** The trailer player is a fixed
element at the document root, so its mute button is not a descendant of the card;
reaching for it fired `mouseleave` and took the button away mid-reach.

Two things that test has to get right, both found on the tiles at the ends of a row:

- **The card is not the only thing that keeps it alive — so is its own tile.** The card
  is clamped to the viewport, so for the first tile it is pushed inward to `margin`,
  leaving part of that tile outside the card's box. Pointing at the poster you were
  previewing dismissed the preview. The test is the union of the card and the anchor
  tile.
- **A scroll EVENT is not a scroll.** `.row-scroller` is `scroll-snap-type: x proximity`
  and `.tile:hover` scales to 1.04, so hovering a tile changes the snap geometry and the
  browser re-snaps, firing a scroll event with nothing having moved. At the ends of a
  row that re-snap really does shift the scroller, which is why the first and last tiles
  flashed a card and lost it while the middle of the row was fine. Watch the anchor
  tile's CENTRE instead: a centred scale leaves it where it was, genuine scrolling moves
  it.

Separately, `.pager` is a full-height 3.5rem strip at `z-index: 3`. Once a row has been
scrolled, tiles pass under it and its share of the edge tile cannot be hovered at all —
no card, rather than a flashing one. That is Netflix's behaviour too and has been left
alone; narrowing the pager or reserving a gutter would be the fix if it ever matters.

## Audio output

**Never pass `--ao=`.** Pinning an audio output caused a silent-playback bug that took
three wrong theories to find. On the affected Mac:

```
[ao/coreaudio] unable to set the input channel layout on the audio unit (-50)
AO: [avfoundation] 48000Hz 5.1(side) 6ch      <- mpv's fallback, works
```

mpv recovers from a broken coreaudio device on its own. Naming an AO removes that
fallback chain and leaves a dead device with no sound — while `aid`, `mute`, `volume`
and the channel counts all read perfectly healthy, which is why it is so hard to spot.
`--audio-channels` defaults to mpv's own `auto-safe` for the same reason: plain
`mpv --no-config` plays this content correctly, so match it.

`pnpm play --ao=` and `--channels=` override both for diagnosis. When audio is wrong,
compare against `mpv --no-config <file>` FIRST — the difference between that and our
config is always the answer.

## Quality tiers and content

The opening tier accounts for BOTH the GPU and the resolution being played —
`suggestTierForContent`. 2160p is four times the pixels of 1080p and the expensive
passes (chroma scaling, multi-pass debanding) scale with pixel count, so an M1 Pro
that holds Reference at 1080p drops ~6% of frames on a 4K REMUX.

When benchmarking a tier, use real footage with motion and detail. An earlier
"Reference runs clean" conclusion came from 25 seconds of a near-static studio logo
and was simply wrong.

## Report what happened, not what was configured

`packages/player/src/status.ts` reads every fact back from mpv after playback starts:
source colourspace vs OUTPUT colourspace, the colourspace hint as mpv sees it,
`hwdec-current`, and the real audio channel counts.

This exists because a Dolby Vision remux was being flattened to SDR for weeks and
nothing noticed — the config said HDR was on, and no code ever checked the result.
Every setting is a REQUEST mpv may decline: hardware decode falls back, an HDR hint can
be refused by the compositor, a 7.1 track gets downmixed by the device. Printing the
request is worse than printing nothing, because it looks like confirmation.

`video-out-params` alone is insufficient — tone-mapping happens inside the GPU renderer
and may not be reflected there — so the hint is read back too and both are reported.
The three states are distinguished deliberately: passthrough working, passthrough
disabled, and passthrough requested but declined.

## HDR passthrough is ON by default

`--target-colorspace-hint=yes`, no tone-mapping. It was off out of caution over
MoltenVK colourspace crashes and ProMotion vsync jitter; neither appeared in testing on
Apple silicon, while the cost was severe — a Dolby Vision remux on a 1600-nit XDR panel
was being flattened to SDR, discarding the whole point of the file.

`--no-hdr` (or `hdrPassthrough: false`) restores bt.2390 tone-mapping, which is the
right choice only for a display that genuinely cannot show HDR.

If HDR looks DIMMER than SDR, the cause is almost always one of three things, in order
of likelihood:
1. **An underestimated target peak.** `--peak=1600`, or `NFL_TARGET_PEAK=1600` for the
   app, asserts an XDR panel's capability where mpv's `auto` guesses low. The status
   line prints the peak in force.
2. **HDR disabled in System Settings → Displays.** No EDR headroom means highlights
   have nowhere to go.
3. **mpv too old.** EDR handling improved after 0.37; `pnpm doctor` flags it. Check the
   version on the MACHINE IN QUESTION — a version read from a different environment is
   worthless, and I once diagnosed this from the wrong mpv entirely.

Measure before changing anything: a screenshot of PQ content captured into SDR looks
dark and desaturated regardless, so screenshots are not evidence about the screen.

## The watchdog climbs back

Quality adaptation is BIDIRECTIONAL. Demotion-only was a ratchet: one bad sample —
during a scan, with other apps loaded, or on an unusually heavy scene — pinned the
machine at a lower tier permanently, because the ceiling was persisted and never
revisited. A 16-core M1 Pro was observed running at `Efficient`, the lowest tier.

Promotion is slower than demotion (45s of clean playback to start) and backs off by
doubling after each demotion, up to 10 minutes, so a marginal machine settles instead
of oscillating.

NOTHING is persisted across sessions. `recordObservedCeiling` is a deliberate no-op.

Persisting a measured ceiling caused three separate bugs and ended with a 16-core M1
Pro starting every session at `Efficient`. What it recorded was the WORST moment the
machine ever had — a background scan, another app compositing, one heavy scene — then
applied that verdict forever. Each fix (version bumping, separating the promotion
ceiling) addressed a symptom; the persistence itself was the cause.

Every session now starts at what the hardware and content warrant and adapts in both
directions. The watchdog reacts in about ten seconds, so a brief opening stutter costs
far less than permanently running two tiers low. Do not reintroduce this.

Bump `QUALITY_MODEL_VERSION` when the meaning of `observedCeiling` changes, not just
when tier costs do — a ceiling recorded under different rules is worse than none.

## Capability cache

`observedCeiling` in `~/.cache/netflix-local/capabilities.json` records the highest
tier a machine sustained — but only for the tier definitions in force at the time.
Bump `QUALITY_MODEL_VERSION` in `capabilities.ts` whenever tier costs change, or a
machine demoted under old definitions stays capped forever with no visible reason.
`pnpm doctor` prints the current ceiling and how to clear it.

## Identity comes from content, not location

A file is identified by `contentId` — a hash of its size, first and last megabyte, and
duration. NOT by volume + path. This is the most important rule in the codebase.

The old model keyed media on where it lived, so identity broke whenever the location
was unwritable (NTFS on macOS, optical, NAS), borrowed, renamed or copied. Borrowed
media is not an edge case, and a design that only works on disks you own is wrong.

The data model:

    Title
     └─ media[]           identified by contentId
         └─ sightings[]   { volumeId, relPath, fingerprint, lastSeen }

A file is not *on* a volume; it has *been seen* on volumes. What this buys:

- Borrowed drives are catalogued WITHOUT WRITING ANYTHING to them.
- A film copied to your own drive is recognised instantly, keeping its metadata.
- The same film on two drives is one title with two sightings, never a duplicate.
- Renames and cross-drive moves cost nothing, because the bytes did not change.

`fingerprint` (size + mtime) lives on the SIGHTING, not the media entry. It describes
a file at a location: copying a film gives the copy a new mtime while the content is
identical, so a per-media fingerprint would make every copy look like a modification.

NOTHING is ever written to a scanned drive — no identity file, no artwork, no metadata.
All of it lives in the project's `data/` directory. This is unconditional; do not
reintroduce a "is this drive mine?" question or a writable-drive special case. Both
existed briefly and produced bugs plus a prompt the user should never have seen.
Content addressing means a drive needs no marking to be recognised again.

## Portable metadata (drive sidecar)

Title metadata lives in `<libraryRoot>/.netflix-local/` on the drive AND is mirrored
locally. The drive is the source of truth; the mirror is what lets an unplugged drive
still render its tiles (§8.5) — metadata that lived only on the drive would disappear
the moment it was ejected.

`readVolumeIdentity()` is load-bearing: pairing reuses the volume id recorded on the
drive. If a second machine minted a fresh id, every `media.volumeId` would point at a
volume it has never heard of and the whole library would resolve as "missing". Never
generate a new id for a drive that already carries one.

NEVER put on the drive: watch history, My List, paired roots, mount paths, cached
trailers. Handing someone a drive must not hand over your viewing history.

## Where user data lives

EVERYTHING the app writes is under ONE directory: `data/` in the project root.

    data/db/      title records — derived, rebuildable by rescanning
    data/state/   watch history, My List, paired volumes — yours, NOT rebuildable
    data/cache/   TMDB responses, artwork, capabilities.json, mpv-shaders — disposable
    data/.env     the TMDB token

Nothing is written to `~/.cache`, `~/Library/Application Support`, or anywhere else.
`packages/player` keeps its own caches there too, via `cache-dir.ts` — it deliberately
does not import `@nfl/core` for this (the player is the playback seam and has no
dependencies), but it honours the same `NFL_CACHE_DIR` / `NFL_DATA_DIR` overrides, so
the two cannot disagree about where the user pointed them.

**The root is found by MARKER (`pnpm-workspace.yaml`), never by counting `..`.** This is
not a style preference. Counting three levels up lands on the root from
`packages/core/src/`, which is where the CLI runs it — but the Electron main process
BUNDLES `@nfl/core` into `apps/desktop/out/main/`, and three up from there is
`<repo>/apps`. So the app kept its library in `apps/data` while `pnpm scan` and
`pnpm doctor` read `data/`, and each reported confidently on a directory the other had
never touched. `findProjectRoot` and `paths.test.ts` pin it.

`state/` is the one that matters: nothing regenerates it, which is why watch history
survives a prune, a rescan, or deleting `db/` outright.

**`data/` is gitignored and is NOT in a distributed zip.** Replacing the project folder
wholesale therefore erases it — copy `data/` across first, or set `NFL_DATA_DIR`
somewhere outside the project. `pnpm doctor` prints which of those two situations you
are in; it used to print "outside the repo, so updating the code cannot erase it"
directly beneath a path inside the repo, and that false reassurance was worse than
saying nothing.

Per-directory overrides (`NFL_DB_DIR`, `NFL_STATE_DIR`, `NFL_CACHE_DIR`) still win,
which is how the tests point elsewhere.

## Packaging (the DMG)

`pnpm dist` → `apps/desktop/release/Nerdflix-<version>-arm64.dmg`. Config lives in
`apps/desktop/electron-builder.yml`.

It packages cleanly only because electron-vite already emits a self-contained `out/` —
every `@nfl/*` package is compiled in and only `electron` stays external — so there is
no `node_modules` to ship and none of the usual pnpm hoisting pain.

Four things that each broke the build or the built app:

- **Electron must be PINNED, not a range.** electron-builder downloads a specific
  platform binary and cannot resolve `^44.3.0`. Pinning is right anyway: Electron is a
  runtime, not a library to float.
- **`identity: null`.** Signing needs a paid Apple Developer account. Forcing a
  signature without one produces an app that fails to launch, which is worse than one
  that warns. Unsigned means right-click → Open the first time, and the README says so.
- **`pnpm.ignoredBuiltDependencies: [electron-winstaller]`.** A Windows-only transitive
  dep whose blocked build script fails the entire install. We only ever target macOS.
- **The packaged app needs `data-dir.ts`, imported FIRST in main.** See below.

**Where a packaged build keeps data — and why `app.setName` is load-bearing.**
`findProjectRoot` looks upward for `pnpm-workspace.yaml`; inside a `.app` there is none,
so it falls back to counting directories and lands inside the bundle — read-only, and
replaced on every update. A packaged build therefore sets `NFL_DATA_DIR` explicitly.

But `app.getPath('userData')` derives from `package.json`'s `name`, which in this
workspace is `@nfl/desktop` — so the first build created a literal **`@nfl` folder** in
the user's Application Support. `app.setName('Nerdflix')` has to run before any
`getPath` call, which is why that module is the first import in `main/index.ts`
(`dataPaths()` runs at module scope, and imports evaluate in order).

Our data then goes in a `data/` SUBFOLDER of userData, not loose in it: Electron keeps
Chromium's caches, session storage and preferences there, and a library sitting among
them invites "clear the app's data" taking watch history with it.

Verified on a real packaged build: `~/Library/Application Support/Nerdflix/data/{db,state,cache}`,
and nothing written inside the bundle.

## electron-vite bundling

`electron` MUST stay external in the main and preload builds. The npm `electron`
package is a shim whose index.js reads `path.txt` from its own directory to find the
real runtime; bundle it and that lookup resolves against `out/main/` instead, throwing
"Electron failed to install correctly" — which reads like a broken download but is a
bundling bug. Supplying a custom `build.rollupOptions` displaces electron-vite's
default external list, so `external` has to be restated explicitly.

The `@nfl/*` workspace packages are the opposite: they MUST be bundled, because their
package.json `main` points at TypeScript source that Electron's Node cannot load.

## Electron runtime

Electron is a small npm package plus a ~280 MB postinstall download. pnpm gates
postinstall scripts behind `allowBuilds` AND its own record of what it has already
built — and a cached store entry can be replayed without running the script, leaving
a package that looks installed but has no `path.txt` or `dist/`. electron-vite then
fails with the unhelpful `Error: Electron uninstall`.

`scripts/ensure-electron.mjs` runs as a root postinstall and checks for the artefact
rather than trusting the package manager. Do not remove it in favour of an
`allowBuilds` entry; that is what failed. It deliberately does not fail the install,
because every CLI tool works without Electron.

## Testing note

`packages/core/src/scan/parse.test.ts` pins three real regressions found on the first scan
run: the parser's TV mode hallucinating seasons from year digits, the year being dropped
as a result, and quality flags (`uhd`, `dolbyVision`) leaking into the edition field.
Do not relax these tests without a replacement case.
