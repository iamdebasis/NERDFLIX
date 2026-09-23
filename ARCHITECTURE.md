# Local Netflix — Architecture

**Status:** Locked
**Target:** macOS 14+, Apple Silicon (any generation), single user, offline-capable
**Last updated:** 2026-09-23 (TV shows, §5, §7.2–7.4)

This document is the source of truth for architectural decisions. It is written to be read
by both humans and coding agents. If an implementation disagrees with this document, the
document wins until it is explicitly amended.

---

## 1. Decision record

| Layer | Choice |
|---|---|
| Shell | Electron (arm64 only) |
| UI | React 19 + TypeScript + Vite + Tailwind + Motion |
| Playback | libmpv / mpv, never HTML5 `<video>` for library content |
| Probe | ffprobe (bundled binary) |
| Metadata store | One JSON file per title, validated by Zod |
| Query index | SQLite (better-sqlite3), derived and disposable |
| Artwork / trailers | TMDB API + yt-dlp, materialized into a local cache |
| Package manager | pnpm |

### Rejected, and why — do not re-litigate without new information

- **HTML5 `<video>` for library playback.** Chromium cannot demux Matroska and cannot
  decode DTS, DTS-HD MA, or TrueHD at any version. HEVC support is inconsistent. This is
  not a tuning problem; it is a capability wall.
- **On-the-fly ffmpeg transcoding to HLS/fMP4.** Defeats the entire purpose of a REMUX
  library. Lossless audio would be destroyed and HEVC would still need browser support.
- **Safari as a runtime.** Same codec walls, plus WebKit's negative standards position on
  the File System Access API means `showDirectoryPicker()` does not exist. Persistent
  folder access is unimplementable there.
- **Tauri v2.** WKWebView efficiency is real, but it relocates the scanner, volume
  manager, TMDB client, and mpv control into Rust, and makes a very low-adoption libmpv
  plugin load-bearing.
- **Fully native SwiftUI + libmpv.** Best-engineered option in the abstract. Rejected on
  velocity: slower iteration on a UI that will be tweaked hundreds of times, and a second
  language to maintain alongside the metadata CLI.
- **A filename parser's TV mode for episode numbering.** `@ctrl/video-filename-parser`
  with TV parsing on reads `Star.Wars.Episode.4.A.New.Hope.1977` as episode 4 of a show
  called *Star Wars*, a `Season 01` folder as a show called *Season*, misses `S08E01E02`,
  and drops the series year. A film misread as an episode vanishes from the film
  shelves, so numbering has a strict hand-written gate instead. See §7.3.
- **mpv `--wid` window embedding on macOS.** Documented as unreliable inside Electron on
  this platform — can produce audio with a black video surface. Use the render API path
  when embedding, or the two-window overlay before that.

### Accepted costs

- ~200 MB app bundle.
- Higher idle memory and worse battery than a WebKit shell.
- No macOS security-scoped bookmarks. Mitigated by volume-UUID resolution plus a
  `/Volumes` watcher for mount and unmount events.

---

## 2. Hard platform constraints

These are properties of macOS, not of our design. Encode them in the UI rather than
fighting them.

**Do not hardcode a chip table.** Capabilities differ across Apple Silicon generations and
will keep changing. Detect at runtime and cache the result — see §2.1.

**Audio.** macOS cannot bitstream TrueHD, DTS-HD MA, or E-AC3 over HDMI. Everything is
decoded to PCM. For lossless formats this is bit-identical to what a receiver would
produce, so there is no fidelity loss — but Atmos and DTS:X object layers collapse to
their 7.1 or 5.1 bed. Never build a passthrough toggle. Label tracks honestly:
`TrueHD Atmos 7.1 → PCM 7.1`.

**Video decode.** Every Apple Silicon media engine hardware-decodes HEVC (8 and 10-bit),
H.264, and ProRes. Treat that as the floor. Beyond it, support varies:

- **AV1** has hardware decode on M3-generation chips and later; earlier chips fall back to
  software dav1d. 4K AV1 in software is playable but hot and power-hungry, and the gap
  between a base chip and a Max is large.
- **VC-1** (older Blu-ray remuxes) is software-only on all current Apple Silicon.

Resolve this at runtime, never from a lookup table.

**Rendering.** `vo=gpu-next` requires `gpu-api=vulkan` via MoltenVK on macOS; libplacebo
has no Metal backend and OpenGL is deprecated on Apple platforms. Known friction: crashes
around colorspace/EDR metadata, and vsync jitter on high-refresh displays (120 Hz and
above, i.e. any ProMotion panel). **HDR passthrough ships as an opt-in toggle, not a
default.** Default to tone-mapping.

### 2.1 Capability detection

Three things vary by machine and display. Probe all three; store nothing chip-specific.

| Capability | How to detect | Consumed by |
|---|---|---|
| Hardware decode for a codec | Play the file, read mpv's `hwdec-current`. If it reports `no` while `hwdec=auto-safe` was requested, decode fell back to software. | `softwareDecode` warning, AV1 pre-transcode prompt |
| Display HDR | `window.matchMedia('(dynamic-range: high)')` in the renderer | Whether the HDR passthrough toggle is offered at all |
| Refresh rate | `screen.getPrimaryDisplay().displayFrequency` in main | Frame-pacing profile; apply the high-refresh mitigation at ≥120 Hz |

The decode probe is the important one. **Measure, don't predict.** Reading
`hwdec-current` is ground truth on hardware that doesn't exist yet, which a chip table
never will be. Cache results in `state/capabilities.json` keyed by
`sysctl -n machdep.cpu.brand_string` so the probe runs once per codec per machine.

**Library size.** REMUX titles run 50–80 GB. A few hundred titles is 20–40 TB, which will
not be attached at once. **Most of the library is offline most of the time.** This is a
first-class UI state, not an error case.

---

## 3. Repository layout

```
netflix-local/
├─ apps/
│  ├─ desktop/              Electron main + preload
│  │  ├─ src/main/          window management, IPC handlers, protocol
│  │  ├─ src/preload/       contextBridge surface
│  │  └─ electron.vite.config.ts
│  └─ ui/                   React renderer
│     ├─ src/routes/        Home, Detail, Player, Setup
│     ├─ src/components/
│     └─ src/lib/           typed IPC client, stores
├─ packages/
│  ├─ core/                 scanner, schema, volumes, metastore, index
│  ├─ player/               PlaybackEngine interface + implementations
│  └─ cli/                  scan, probe, enrich, add-title, validate, doctor
├─ .claude/skills/
│  └─ add-title/SKILL.md    agent instructions for metadata ingestion
├─ db/
│  ├─ movies/*.json         SOURCE OF TRUTH — agent-writable, git-tracked
│  ├─ shows/*.json
│  └─ index.sqlite          derived, disposable, gitignored
├─ state/
│  ├─ progress.json         resume positions, watched flags
│  ├─ lists.json            My List, thumbs
│  └─ volumes.json          paired library roots
├─ cache/                   gitignored
│  ├─ art/{id}/
│  ├─ trailers/{id}.mp4
│  └─ thumbs/{id}/
└─ ARCHITECTURE.md
```

**Invariant:** `db/` is hand- and agent-editable. `state/` is app-owned. `cache/` is
regenerable. Deleting `index.sqlite` or `cache/` must never lose user data. Regenerating
`db/` must never touch `state/`.

---

## 4. Process model

```
┌─ Electron main (Node) ─────────────────────────────────────┐
│  VolumeManager    pairing, timed reachability, /Volumes watch│
│  LibraryScanner   worker thread; discover→parse→probe→match  │
│  MetaStore        db/*.json ←Zod→ typed records              │
│  IndexStore       SQLite; search, sort, filter               │
│  StateStore       progress / lists                           │
│  MediaProtocol    media:// handler for art + trailers        │
│  PlaybackEngine   owns the mpv session                       │
└──────────────▲──────────────────────────────────┬───────────┘
               │ contextBridge (typed)            │
┌──────────────┴──────────────────────────────────▼───────────┐
│ Renderer (React)                                            │
│   Home / Detail / Player / Setup                            │
└─────────────────────────────────────────────────────────────┘
```

**Rules:**
- The renderer never imports `fs`, `path`, or `child_process`. All disk access is IPC.
- Artwork and trailers are served via a registered `media://` protocol handler, not
  `file://`. `webSecurity` stays on; the renderer stays sandboxed.
- The scanner runs in a worker thread and streams progress. It must never block paint.

---

## 5. Data model

### 5.1 Title record — `db/movies/<slug>.json`, `db/shows/show-<slug>.json`

```ts
const Title = z.object({
  id: z.string(),                          // slug: "terminator-2-judgment-day-1991"
  tmdbId: z.number().optional(),
  type: z.enum(['movie', 'show']),

  title: z.string(),
  sortTitle: z.string(),
  originalTitle: z.string().optional(),
  year: z.number(),
  tagline: z.string().optional(),
  overview: z.string(),
  genres: z.array(z.string()),
  runtimeMinutes: z.number(),
  certification: z.string().optional(),    // "U/A 16+"
  contentTags: z.array(z.string()),        // ["substances", "coarse language"]
  cast: z.array(z.object({ name: z.string(), character: z.string().optional() })),
  directors: z.array(z.string()),
  studio: z.string().optional(),

  trailer: z.object({
    source: z.enum(['youtube', 'local']),
    url: z.string().optional(),
    localPath: z.string().optional(),
    startAt: z.number().optional(),
  }).optional(),

  artwork: z.object({
    poster: z.string().optional(),
    backdrop: z.string().optional(),
    logo: z.string().optional(),           // transparent clear-logo PNG
  }),

  media: z.array(MediaFile).min(1),
  similarIds: z.array(z.string()).default([]),

  matchState: z.enum(['auto', 'confirmed', 'review', 'unmatched']),
  matchConfidence: z.number().min(0).max(1),
  addedAt: z.string().datetime(),
});
```

**Shows are Titles too**, with `type: 'show'` and every episode file in `media[]`. The
id is prefixed `show-` so a series and a film of the same name never collide, and the
records live in their own directory. Show-only fields:

```ts
  creators: z.array(z.string()),           // a show's director changes per episode
  originCountry: z.string().optional(),    // TMDB code; "GB" for a `.UK` release
  endYear: z.number().optional(),          // set only once TMDB says the show has ended
  seasonInfo: z.array(SeasonInfo),         // OWNED seasons only: name, airYear, episodeCount
  episodeInfo: z.array(EpisodeInfo),       // OWNED episodes only: name, overview, runtime, still
```

`seasonInfo` and `episodeInfo` are keyed by season and episode number, not by file,
because one episode can exist in several copies. `episodeCount` is TMDB's total, which
is what lets the UI say "8 of 10 episodes" rather than implying you own the lot.

### 5.2 Media file

One title may have several. Editions are why.

```ts
const MediaFile = z.object({
  volumeId: z.string(),
  relPath: z.string(),                     // relative to the volume root
  releaseName: z.string(),                 // original scene string, verbatim
  edition: z.string().optional(),          // "Theatrical Cut", "Hybrid"
  source: z.string().optional(),           // "UHD BluRay REMUX" — from filename
  releaseGroup: z.string().optional(),

  container: z.string(),                   // ffprobe
  videoCodec: z.string(),
  profile: z.string().optional(),          // "Main 10"
  resolution: z.string(),
  hdr: z.enum(['SDR', 'HDR10', 'HDR10+', 'HLG', 'DV']),
  dvProfile: z.number().optional(),
  bitrateMbps: z.number(),
  sizeBytes: z.number(),
  durationSec: z.number(),
  // NOT stored. Decode capability is a property of the machine, not the file, and the
  // same db/ may be read on a different Mac. Resolve at render time from
  // state/capabilities.json — see §2.1.

  audio: z.array(z.object({
    codec: z.string(), channels: z.number(),
    lang: z.string().optional(), bitrateKbps: z.number().optional(),
    title: z.string().optional(),
  })),
  subtitles: z.array(z.object({
    lang: z.string().optional(), format: z.string(), forced: z.boolean(),
  })),
  chapters: z.array(z.object({ title: z.string(), startSec: z.number() })),

  fingerprint: z.string(),                 // hash(size + mtime) — re-probe trigger

  // Episodes only — from the filename and its folders (§7.3).
  season: z.number().optional(),           // 0 is Specials
  episode: z.number().optional(),
  episodeEnd: z.number().optional(),       // S08E01E02 → episode 1, episodeEnd 2
  episodeTitle: z.string().optional(),     // fallback only; TMDB's name wins
});
```

Episodes of a show are grouped into **slots** (`library/episodes.ts`): one slot per
season and episode, holding every copy of it. Playing an episode resolves among THAT
slot's copies only (`resolveAmong`) — resolving across the whole show would hand back
whichever episode happened to be on a connected drive, which is a different episode.

### 5.3 Field authority

Three inputs, no overlap. Do not let them contradict each other.

| Source | Owns |
|---|---|
| **ffprobe** | resolution, codecs, bit depth, HDR type, audio tracks, subtitle tracks, duration, chapters, real bitrate |
| **Filename** | edition, source (UHD BluRay vs WEB-DL), REMUX vs encode, release group; for TV, series name and season/episode number |
| **TMDB** | canonical title, year, overview, genres, cast, directors, certification, artwork, trailer URL; for TV, creators, network, season and episode names, synopses, stills |

Never parse HDR or audio from the filename. ffprobe reads the actual stream.

Episode numbering is the one structural fact only the filename can supply: ffprobe
cannot know which file is S02E05, and TMDB can describe an episode only once we have
said which one it is. The filename's episode title is kept as a fallback for display
and never overrides TMDB's.

### 5.4 User state — `state/progress.json`

Kept separate so regenerating `db/` cannot destroy watch history.

```ts
{
  version: 1,
  progress: { [titleId]: { mediaIndex, positionSec, durationSec, watched, lastPlayedAt,
                           contentId? } },    // for a show: the episode last touched
  episodes: { [contentId]: { positionSec, durationSec, watched, lastPlayedAt } },
  myList: string[],
  tracks: { [titleId]: { audio?, subtitle? } },
  thumbs: { [titleId]: 'up' | 'down' },
}
```

Episode progress is keyed by `contentId`, for the same reason media is: renaming or
moving an episode must not lose your place in it. A show's own `progress` entry names
the episode last touched, which is what next-up follows — it resumes that episode if
unfinished, otherwise offers the one after it, and never advances into Specials.

**Nothing may cost the whole file.** mpv reports an unavailable `time-pos` with no
value as a file unloads; recorded as-is it made the file invalid, and the old loader
answered an invalid file by starting empty — so the next write saved an empty slate over
all watch history. Four layers now stand between that and `state/`:

1. The engines pass `null`, never nothing, for a property with no value.
2. Callers record only a finite number.
3. The store refuses to write anything that is not a non-negative finite position.
4. `load()` validates entry by entry, keeps everything valid, preserves the original
   byte for byte as `progress.json.invalid-<timestamp>` (or `.unparseable-` when it is
   not JSON at all), and writes the repaired file back so the next launch does not
   salvage again. Concurrent loads share one read, so two callers can never hold two
   copies of state and have one copy's writes lost.

`state-safety.test.ts` replays the exact corrupted file observed on a real run.

---

## 6. Volume management

```ts
type LibraryRoot = {
  id: string;
  label: string;                            // "Plex SSD"
  kind: 'local' | 'removable' | 'smb' | 'nfs';
  path: string;                             // last known mount point
  volumeUUID?: string;                      // diskutil info -plist
  sentinel: string;                         // rel path proving the mount is real
  remote?: { host: string; share: string; credentialRef: string };
};
```

**Boot sequence:**
1. Probe each root with a **2-second timeout** wrapper. An unreachable SMB mount will
   block a naive `fs.access` for 30+ seconds. This timeout is not optional.
2. If the path moved, resolve by `volumeUUID` before declaring the root missing.
3. Render Home immediately from the cached index. Rescan in the background.
4. Missing roots produce a "Reconnect" screen naming the specific drive, with
   Retry / Locate / Continue offline. Offline continues to Home with tiles disabled.

**Live detection:** watch `/Volumes` with chokidar. Mount and unmount events fire
immediately; re-run the affected root's probe and update availability in place.

**NAS:** never implement SMB in-process. Ask the OS to mount it (`mount_smbfs`), store
credentials in Electron `safeStorage` (Keychain-backed), and treat the result as a plain
path. Everything downstream sees a directory.

---

## 7. Scanner

### 7.1 Release-unit detection

The library uses scene naming in three shapes: a bare `.mkv`, a release folder
containing exactly one `.mkv` plus junk, and a CONTAINER holding any number of those,
nested arbitrarily deep.

```
for each entry at a root:
  if VIDEO_EXT and size > 200MB:
      unit { file: entry, releaseName: basename(entry, ext) }

  if directory:
      videos = walk(entry, maxDepth 2).filter(feature).filter(!junk)

      RELEASE FOLDER — exactly one video, sitting DIRECTLY inside, and the folder name
                       describes it → unit { releaseName: folder name }
      MULTI-PART     — several videos differing only by CD1/CD2/part1 → REVIEW
      otherwise      — a container: RECURSE into it, same rules, to MAX_CONTAINER_DEPTH
      no videos      — BDMV/ or VIDEO_TS/ ? disc unit : recurse, then report if empty
```

**Recursion is the point.** The original version stopped at one level and recorded a
folder holding more than one feature as a `multiple-features` issue, on the assumption
that it was a multi-part release or a season pack. Real libraries nest: a folder called
"Star Wars Collection" holding eight films contributed *nothing*, and the only way to
see them was to pair that subfolder as a library of its own. Silently discarding eight
films is a far worse failure than the duplicate a genuine multi-part release might
produce, so the default is to look inside and the multi-part case is detected narrowly.

**"One video inside" is NOT enough to call something a release folder.** Two further
conditions, both learned from real trees:

- **The video must sit directly inside it.** Without this,
  `1980s/Sci-Fi/Ridley Scott/Blade.Runner.mkv` produced a film called *1980s* — the
  feature was found two levels down and the top folder claimed it.
- **The folder name must describe the file** (`folderDescribesFile`: a prefix relation
  between the two, normalised). Without this the same film in a director folder became
  *Ridley Scott*. Scene releases name the folder and the file the same thing, sometimes
  with a tracker tag glued on the end, so a prefix relation is the signal.

Everything failing those tests is a shelf, and a shelf gets looked into rather than
named. Depth is capped and directories are visited once by inode, because a symlink
loop on a NAS share would otherwise walk forever and a scan that never finishes looks
exactly like a scan that crashed.

**Prefer the folder name** when it genuinely describes the file — scene folder names
are canonical and complete, while the file inside is sometimes truncated.

### 7.2 Junk filter

```
.DS_Store  ._*  .Spotlight-V100  .fseventsd  .Trashes  .TemporaryItems
$RECYCLE.BIN  "System Volume Information"  @eaDir
*.txt  *.nfo  *.sfv  *.srr  *.jpg  *.png
Sample(s)/  Proof/  Screens/  Screenshots/  Extras/  Featurettes/  Subs/  Subtitles/
Bonus/  "Behind the Scenes"/  "Deleted Scenes"/  Interviews/  Trailers/
```

Kept in step with `JUNK_DIRS` in `scan/junk.ts` — `Subs/` was once listed here and not
there, and a stray video inside it counted as a second feature. Change both together.

A file with an explicit `SxxEyy` marker uses a 20 MB size floor instead of the feature
floor: a half-hour SDR episode is legitimately far smaller than any film remux.

### 7.3 Parsing

Use `@ctrl/video-filename-parser` (Radarr-derived) for films. Strip tracker tags like
`[TGx]` before parsing or they contaminate the release group. Do **not** use its TV mode
(§1, rejected).

Episodes are recognised by `scan/episode.ts`, and only on one of three pieces of
evidence:

1. An explicit `S01E04` (or `S08E01E02`, `S08E01-E02`) anywhere in the name.
2. `1x04` — but only with a series name before it, or directly inside a season folder,
   because `10x10` is also the name of a film.
3. A name that opens with a number, DIRECTLY inside a folder that names the season
   (`Season 1/`, `S01/`, `Specials/`). Two levels down is a featurette, not an episode.

Nothing else is an episode. A film misfiled as TV disappears from the film shelves,
which is worse than an episode left on them. `Star.Wars.Episode.4` and friends are in
`episode.test.ts` as cases that must stay films.

The series name comes from the file itself first, then from the nearest folder that is
not a season folder or a generic one (`TV/`, `Shows/`), reading a season-pack folder
(`Show.S02.2160p.REMUX`) for its series part. A trailing year (`Doctor.Who.2005`) and a
country suffix (`The.Office.UK` → `GB`) are split off and kept: they are what separate a
remake from its original.

The folder path relative to the library root is passed to `parseRelease` so this
context is available; a file that looks like TV but carries no episode number is
reported as `tv-without-episode` and skipped rather than guessed.

**Grouping into shows is by normalised name, and year and country can only EXCLUDE.**
A show split in two is visible and fixable; *The Office* (UK) merged into *The Office*
(US) mixes two shows' episodes into one list and is not.

Scene naming eats punctuation — `Terminator.2.Judgment.Day` must match TMDB's
*Terminator 2: Judgment Day*. The matcher is punctuation-insensitive.

### 7.4 Matching

Score candidates on normalized title distance plus exact year agreement. Auto-accept only
when both are strong. Everything else becomes `matchState: 'review'` and surfaces in a
**"Needs attention"** row on Home with a three-poster picker.

**Once `matchState` is `confirmed`, freeze it.** Rescans must never re-match a confirmed
title.

**Shows** are matched against TMDB's TV search with stricter rules than films:

- The name must be near-exact (≥ 0.95). The film matcher accepts a prefix at 0.9
  because releases keep subtitles TMDB drops, but TV spin-offs share prefixes (*Star
  Wars* / *Star Wars: The Clone Wars*), so for a show a prefix is neither enough to
  accept nor enough to count as a rival.
- A rival is another near-exact name that the file's year and country do not rule out.
  Any rival sends the show to review. That is the remake case, and *The Office* with no
  year or country is genuinely ambiguous.
- Popularity is never a tie-breaker. The more popular show is not more likely to be
  the one on your drive.

TV and film ids are separate number spaces at TMDB, so the raw-response cache is
namespaced (`cache/tmdb/tv/`). A show is re-enriched when new episodes arrive that it has
no description for, and only owned seasons and episodes are fetched and stored. TV's
compound genres are split onto the film names ("Sci-Fi & Fantasy" → Science Fiction,
Fantasy) so a genre row can hold both.

### 7.5 Caching

Re-probe only when `hash(size + mtime)` changes. This is the difference between a
four-minute cold scan and a 400 ms warm one. Stream results over IPC so rows populate
progressively.

---

## 8. UI

### 8.1 The three states of a tile

`Tile → HoverCard → DetailModal` share one Motion `layoutId`. That single decision
produces the Netflix "grow out of the row, then grow into a modal" continuity. Two
disconnected animations will not feel right no matter how they are tuned.

### 8.2 Hover card

- **Portal it.** Rows have `overflow: hidden` for the carousel; the card must render in a
  fixed-position portal at the tile's measured rect or it gets clipped.
- **Timing:** ~400 ms intent delay, ~300 ms scale-up, trailer starts muted at ~800 ms.
  Cancel on mouseleave with a short grace period so diagonal mouse travel doesn't flicker.
- **Edge clamping:** first and last tiles in a row shift transform origin so the card
  never overflows the viewport.
- **Controls:** circular play, add-to-list, thumbs, and chevron-down (expand).

### 8.3 Rows

Paginated carousels, not free scroll. Compute items-per-page from container width,
translate by whole pages, render a peek of the next item. Virtualize: mount visible rows
plus one above and below.

### 8.4 Detail modal

Backdrop trailer looping, clear-logo PNG over it, Resume/Play, add, thumbs, mute toggle,
progress bar (`1 of 114m`), metadata block, version selector when `media.length > 1`,
More Like This grid, episode list for shows.

### 8.5 Availability — required, not optional

Every tile derives availability from its `volumeId` at render time.

- Offline titles get a subtle drive badge; Play becomes `On Plex SSD`.
- A "Downloaded"-style nav toggle filters to attached volumes only.
- Detail modals open fully for offline titles — metadata, artwork, and trailer are local.

Build this into a `MediaResolver` from day one. Retrofitting it is a miserable refactor.

### 8.6 Trailers

Store the YouTube URL in the DB, then materialize locally with `yt-dlp` into
`cache/trailers/{id}.mp4` at 720p H.264/AAC. Hover cards and detail modals use a plain
HTML5 `<video>`. This is the **only** place a video element is acceptable, and it is
acceptable precisely because we control the encode. Instant start, real seekable timeline,
no ads, works offline.

### 8.7 Visual tokens

Netflix Sans is proprietary. Use Inter Tight. Brand red `#E50914`, page background
`#141414`.

---

## 9. Playback

### 9.1 The seam

```ts
interface PlaybackEngine {
  load(path: string, opts: { startAt?: number; audioTrack?: number }): Promise<void>;
  play(): void;
  pause(): void;
  seek(sec: number, mode: 'absolute' | 'relative'): void;
  setTrack(type: 'audio' | 'sub', id: number | 'no'): void;
  observe<K extends MpvProp>(prop: K, cb: (v: MpvPropType[K]) => void): Unsub;
  screenshotAt(sec: number): Promise<Buffer>;
  dispose(): void;
}
```

Two implementations. React never knows which is running.

**Tier 0 — `ExternalMpvEngine` (build this).** A persistent `mpv` process with
`--input-ipc-server`, rendering into its own borderless fullscreen window, with a
transparent frameless Electron window layered above it for controls. Playback in this app
is always fullscreen, so the two-window approach's only real weakness never surfaces.

Overlay window: `transparent: true, frame: false, hasShadow: false,
alwaysOnTop: 'screen-saver'`. Call `setIgnoreMouseEvents(true, { forward: true })` by
default and flip it off the moment controls become visible, back on after the 3-second
idle hide.

**Tier 1 — `EmbeddedMpvEngine` (later).** libmpv render API into an app-owned NSView via a
native addon, or `electron-mpv-video`'s shared-texture path on Electron 40+. Flag flip,
not a rewrite.

### 9.2 One long-lived mpv process

Start mpv once per session with `idle=yes keep-open=yes` and feed it files via `loadfile`.
Spawning per playback costs ~800 ms every time and makes the modal-to-playback transition
feel broken.

### 9.3 mpv configuration

```conf
hwdec=videotoolbox
vo=gpu-next
gpu-api=vulkan
profile=high-quality

tone-mapping=bt.2390
target-colorspace-hint=no       # user-toggleable; see §2
hdr-compute-peak=yes

ao=coreaudio
audio-channels=auto-safe        # no passthrough on macOS, ever

cache=yes
demuxer-max-bytes=1GiB
demuxer-max-back-bytes=256MiB
demuxer-readahead-secs=20       # not optional over network

osc=no
osd-bar=no
no-border
input-default-bindings=no
input-vo-keyboard=no
idle=yes
keep-open=yes
```

### 9.4 Player chrome

Back, title with S/E, scrubber with thumbnail preview, ±10 s, play/pause, volume, audio
track menu, subtitle menu, next episode with autoplay countdown, fullscreen. All React,
reading observed mpv properties (`time-pos`, `pause`, `duration`, `track-list`) at ~10 Hz.

**Scrub previews:** never pre-generate sprite sheets — an 80 GB file would have to be read
end to end. Use the `thumbfast` pattern: a second hidden mpv instance that keyframe-seeks
and screenshots on demand.

**Skip Intro:** read MKV chapters from ffprobe; offer the button when a chapter matching
`/intro|opening/i` exists. Fingerprint detection is out of scope.

---

## 10. Metadata pipeline

### 10.1 Automated path (primary)

```bash
pnpm add-title "/Volumes/SSD/Some.Release.2023.../file.mkv"
```

ffprobe → parse filename → TMDB lookup → confirm match → download poster, backdrop, and
clear-logo → yt-dlp the trailer → write `db/movies/<slug>.json` → `pnpm validate`.

### 10.2 Agent path (gap-filling and offline)

Skill at `.claude/skills/add-title/SKILL.md` documenting the schema, slug convention,
artwork paths, and validation command. Drop screenshots in `inbox/`, tell the agent to add
the title; it runs `pnpm probe <path>` for technical fields, fills narrative fields from
the images, writes the JSON, runs `pnpm validate`.

The Zod schema is what makes this safe: a malformed agent edit produces a hard failure,
not a silently corrupted library.

Use **Claude Code**, not the VS Code extension — it can run probe and validate itself
rather than only editing text.

### 10.3 Never rename files on disk

The DB is the mapping layer. Scene names are unambiguous and encode provenance; renaming
buys nothing and breaks that.

---

## 11. Commands

```bash
pnpm install          # postinstall: doctor checks mpv, ffprobe, yt-dlp
pnpm dev              # vite + electron, HMR on the renderer
pnpm scan <path>      # standalone: parsed table + match confidence, no UI
pnpm probe <file>     # ffprobe → normalized MediaFile JSON
pnpm add-title <path> # full ingestion
pnpm validate         # Zod-check every db/*.json
pnpm doctor           # verify native deps
```

First run: no roots → folder picker or NAS wizard → scan with progress → Home.
Every run after: probe roots → Home in under a second.

---

## 12. Build order

Risk front-loaded. Do not reorder 1 and 2.

1. **Spine.** Electron arm64 + Vite + React skeleton. `pnpm dev` runs. One hardcoded
   folder, ffprobe scan, plain grid. No animation, no polish.
2. **Playback.** Persistent mpv + IPC + transparent overlay window. Prove a 4K REMUX plays
   fullscreen with a working scrubber. **This is the risk milestone — roughly 300 lines
   containing the whole project's uncertainty.** Everything after is known work.
3. **Data layer.** Zod schema, `db/*.json`, SQLite index, volume pairing, reachability
   probes, `/Volumes` watcher, first-run wizard, availability states.
4. **The Netflix surface.** Rows, hover card, detail modal, shared-element transitions.
   Most of the calendar time; pure frontend; most pleasant last.
5. **Ingestion.** TMDB enrichment, yt-dlp cache, agent skill.
6. **Polish.** thumbfast previews, Skip Intro, next-episode autoplay, resume everywhere.

**Start with `pnpm scan` as a standalone CLI before any Electron or UI exists.** It is
testable in isolation, it surfaces the weird cases in the real library within minutes, and
it is the input contract everything else is built on.
