/**
 * Regenerate docs/screenshots/ by driving the running app.
 *
 *   pnpm app:debug          # terminal 1 — the app, with its debugger open
 *   pnpm screenshots        # terminal 2
 *
 * Keep the app window ON SCREEN and the mouse OFF it for the two or three minutes this
 * takes. A hidden window (behind a full-screen player, on another Space) pauses the
 * trailers, so the billboard shot never arrives; and hover cards close by where the
 * REAL pointer is, so moving the mouse over the window cancels the preview shot.
 *
 * Every shot ASSERTS the DOM is in the state it claims to be showing before it writes a
 * file, and waits on that state rather than on a stopwatch. A capture that quietly got
 * an empty modal, or a billboard whose trailer never started, is worse than no
 * screenshot: it is a claim about the product that nobody checked.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { attach, until, wait } from './cdp.mjs';

const run = promisify(execFile);

const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;

/**
 * Captures arrive at the display's device pixel ratio — 2560px wide on a Retina panel,
 * which is three quarters of a megabyte per shot for a page nobody views at that size.
 * `sips` ships with macOS, and this project is macOS-only anyway.
 */
const WIDTH = 1600;

/**
 * How long YouTube's opening chrome lingers.
 *
 * `.trailer-video.is-playing` only means the app has revealed the frame; YouTube's own
 * transport controls and title bar fade on their own schedule — measured in CLAUDE.md
 * as still present at ~1.2s and gone by 5s. Capturing before then puts a pause button
 * and a "Watch on YouTube" strip in the middle of the billboard.
 */
const CHROME_MS = 5200;

const cdp = await attach(9222);
let n = 0;

async function shot(file, description, clip) {
  const target = join(OUT, file);
  await writeFile(target, await cdp.screenshot({ quality: 92, clip }));
  // Shrink to WIDTH, never enlarge: a tight crop is already narrower, and scaling it up
  // to the page width would only make it soft.
  const { stdout } = await run('sips', ['-g', 'pixelWidth', target]);
  const width = Number(stdout.match(/pixelWidth: (\d+)/)?.[1] ?? 0);
  const resize = width > WIDTH ? ['--resampleWidth', String(WIDTH)] : [];
  await run('sips', [...resize, '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', target, '--out', target]);
  const { size } = await (await import('node:fs/promises')).stat(target);
  n += 1;
  console.log(`  ✓ ${file.padEnd(24)} ${description}  (${Math.round(size / 1024)} KB)`);
}

async function assert(expr, what) {
  if (!(await cdp.eval(expr))) throw new Error(`not in the claimed state — ${what}\n    ${expr}`);
}

/**
 * Get the pointer out of the picture.
 *
 * The pointer stays wherever the last click left it, so scrolling a row under it opens
 * a hover card — which is how a capture of the collection rows came back with the row
 * title covered by a preview of something else.
 */
async function park() {
  await cdp.move(8, 8);
  await wait(700);
  await assert(`!document.querySelector('.hover-card')`, 'a hover card is covering the shot');
}

const ROW = (title) =>
  `[...document.querySelectorAll('section.row')].find(s => s.querySelector('.row-title')?.innerText === ${JSON.stringify(title)})`;

/**
 * The films' Recently Added row. It is "Recently Added Movies" when the library also holds
 * shows and plain "Recently Added" when it does not — the script must work on either.
 */
const RECENT_FILMS = `(${ROW('Recently Added Movies')} ?? ${ROW('Recently Added')})`;
const RECENT_SHOWS = ROW('Recently Added TV Shows');

/**
 * Bring a tile into view before pointing at it. Which row comes first depends on the
 * library — once anything is part-watched, Continue Watching sits above Recently Added
 * and pushes it below the fold, where a pointer aimed at it lands on nothing.
 */
async function reveal(expr) {
  await cdp.eval(`${expr}.scrollIntoView({ block: 'center' })`);
  await wait(800);
}

console.log('\nCapturing docs/screenshots/ from the running app\n');

// Start from a known state. The app keeps whatever view, search and filters it was left
// in, so a second run would otherwise begin inside the library and fail on the picker.
await cdp.eval('location.reload()');
await wait(1500);

// --- 1. the picker -----------------------------------------------------------
await until(cdp, `Boolean(document.querySelector('button.card'))`, { timeout: 25000 });
await park();
await assert(`document.querySelectorAll('button.card').length >= 1`, 'no library cards');
await shot('01-library-picker.jpg', 'drive cards and the combined shelf');

// --- into the library --------------------------------------------------------
// "All films", or "Everything" once the library holds a series.
const combined = `[...document.querySelectorAll('button.card')].find(b => /All films|Everything/.test(b.innerText))`;
const anyCard = `document.querySelector('button.card')`;
await cdp.pointer((await cdp.eval(`Boolean(${combined})`)) ? combined : anyCard, { click: true });
await until(cdp, `Boolean(document.querySelector('.browse'))`);
await until(cdp, `document.querySelectorAll('section.row').length >= 3`);

// --- 2. browse, artwork still ------------------------------------------------
// Captured before the billboard comes to life, so the still and the trailer are two
// distinguishable shots rather than the same frame twice.
await wait(1200);
await park();
await assert(`Boolean(document.querySelector('.hero img, .hero-bg'))`, 'hero has no artwork');
await shot('02-browse.jpg', 'hero billboard over the first rows');

// --- 3. the billboard playing ------------------------------------------------
// Wait for the reveal itself (HERO_SETTLE_MS, then the frame's load and
// REVEAL_SETTLE_MS) rather than guessing at a total.
// Generous: the billboard can open on a title with no trailer (a cartoon series) and
// only reaches one with a trailer after its dwell and the next settle.
await until(cdp, `Boolean(document.querySelector('.trailer-video.is-playing'))`, { timeout: 90000 });
await wait(CHROME_MS);
await park();
await assert(`Boolean(document.querySelector('.hero-trailer iframe'))`, 'no player in the hero');
await shot('03-hero-trailer.jpg', 'the billboard playing its trailer');

// --- 4. a collection row -----------------------------------------------------
const collectionRow = `[...document.querySelectorAll('section.row')].find(s => /Collection$/.test(s.querySelector('.row-title')?.innerText ?? ''))`;
await assert(`Boolean(${collectionRow})`, 'no collection row — has the library been enriched?');
await cdp.eval(`${collectionRow}.scrollIntoView({ block: 'center' })`);
await park();
await shot('04-collections.jpg', 'a franchise row, in release order');

// --- 5. hover preview --------------------------------------------------------
// The first row is tall enough that its card is never clamped against the top.
await cdp.eval(`document.querySelector('.browse').scrollTo({ top: 0 })`);
await wait(800);
/*
 * Which film: one whose trailer YouTube will actually play inline. An embed that will
 * not autoplay — it happened to Terminator 3's — shows YouTube's red play button where
 * the preview should be, and the app cannot see inside the frame to tell. Chosen by
 * eye for the library these shots are taken from, and not the billboard's own film.
 */
const PREVIEW_TILE = `${RECENT_FILMS}.querySelectorAll('.tile')[3]`;
await reveal(PREVIEW_TILE);
await cdp.pointer(PREVIEW_TILE);
await until(cdp, `Boolean(document.querySelector('.hover-card'))`, { timeout: 8000 });
// Wait for the PREVIEW player specifically. `.trailer-video` also exists inside the
// hero, so a looser selector matches the billboard's frame and resolves instantly —
// which is how this shot came back with the preview still showing YouTube's controls.
await until(cdp, `Boolean(document.querySelector('.trailer-host .trailer-video.is-playing'))`, {
  timeout: 25000,
}).catch(() => console.log('    (no trailer for that tile — capturing the card itself)'));
// Past YouTube's chrome, and past the distributor logos every trailer opens on.
await wait(CHROME_MS + 7000);
await assert(`Boolean(document.querySelector('.hover-card'))`, 'the hover card went away');
await shot('05-hover-preview.jpg', 'hover card with the trailer playing in it');

// --- 6. the detail view ------------------------------------------------------
await cdp.pointer(PREVIEW_TILE, { click: true });
await until(cdp, `Boolean(document.querySelector('.modal-panel'))`);
await wait(3000);
await assert(`document.querySelector('.modal-panel').innerText.length > 40`, 'the modal is empty');
await shot('06-detail.jpg', 'detail view: logo, resume, technical truth');

await cdp.pointer(`document.querySelector('.modal-close')`, { click: true });
await until(cdp, `!document.querySelector('.modal-panel')`);
// Dismissing the modal resumes the billboard, and YouTube shows its chrome again on
// every state change — the panel shots have the hero behind them.
await wait(CHROME_MS);

// --- 7. the filter panel -----------------------------------------------------
await cdp.pointer(`document.querySelector('.filter-toggle')`, { click: true });
await until(cdp, `Boolean(document.querySelector('.filter-panel'))`);
await wait(500);
await cdp.move(8, 8);
await assert(`document.querySelectorAll('.filter-panel .filter-pills button').length > 0`, 'no facets offered');
await shot('07-filters.jpg', 'sort and filter, with facets from the library');

// --- 8. a result grid --------------------------------------------------------
// 4K is the pill people reach for; fall back to whichever exists in this library.
const pill = `[...document.querySelectorAll('.filter-pills button')].find(b => ['4K','HDR'].includes(b.innerText)) ?? document.querySelector('.filter-pills button')`;
await cdp.pointer(pill, { click: true });
await until(cdp, `Boolean(document.querySelector('.row-grid'))`);
await cdp.pointer(`document.querySelector('.filter-backdrop')`, { click: true });
await until(cdp, `!document.querySelector('.filter-panel')`);
await park();
await assert(`document.querySelectorAll('.row-grid > .tile').length >= 2`, 'the grid is empty');
await shot('08-results-grid.jpg', 'a filtered result set, as a wrapping grid');

// --- 9. the track picker ----------------------------------------------------
await cdp.pointer(`document.querySelector('.filter-toggle')`, { click: true });
await until(cdp, `Boolean(document.querySelector('.filter-panel'))`);
await cdp.pointer(`document.querySelector('.filter-reset')`, { click: true });
await cdp.pointer(`document.querySelector('.filter-backdrop')`, { click: true });
await until(cdp, `!document.querySelector('.filter-panel')`);
await cdp.eval(`document.querySelector('.browse').scrollTo({ top: 0 })`);
await wait(600);

/**
 * Open the first film that actually has a choice to offer.
 *
 * A single-track file shows no picker at all, so naming a title here would quietly
 * capture an empty dialog on any library but this one. The track table arrives on its
 * own IPC round trip after the dialog opens, so each candidate is given a moment.
 */
let pickerShown = false;
for (let i = 0; i < 6 && !pickerShown; i += 1) {
  await reveal(`${RECENT_FILMS}.querySelectorAll('.tile')[${i}]`);
  await cdp.pointer(`${RECENT_FILMS}.querySelectorAll('.tile')[${i}]`, { click: true });
  await until(cdp, `Boolean(document.querySelector('.modal-panel'))`);
  pickerShown = await until(cdp, `document.querySelectorAll('.track-picker select').length >= 2`, {
    timeout: 6000,
  }).catch(() => false);
  if (!pickerShown) {
    await cdp.pointer(`document.querySelector('.modal-close')`, { click: true });
    await until(cdp, `!document.querySelector('.modal-panel')`);
    await wait(400);
  }
}
if (!pickerShown) throw new Error('no title in Recently Added offers a track choice');

/**
 * Select a commentary if the disc carries one.
 *
 * A closed `<select>` reading "Automatic" says nothing about why the picker exists,
 * and the OPEN menu is drawn by macOS rather than the page, so it cannot be captured
 * at all — the chosen value is the only way to show the feature in a still.
 */
await cdp.eval(`
  (() => {
    const sel = document.querySelector('.track-picker select');
    const pick = [...sel.options].find((o) => /commentar/i.test(o.text)) ?? sel.options[1];
    if (!pick) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    set.call(sel, pick.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`);
await wait(CHROME_MS);
await park();
await shot('09-track-picker.jpg', 'audio and subtitles, chosen before playing');

// --- 10–13. TV — only when the library holds a show ---------------------------
await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await wait(700);
const showTile = `${RECENT_SHOWS}?.querySelector('.tile')`;
if (await cdp.eval(`Boolean(${showTile})`)) {
  const browse = `document.querySelector('.browse')`;

  // 13. Films and shows as separate rows, with the season shelf beneath them. The films'
  // row is lifted to just under the nav, so all three rows share one frame.
  await cdp.eval(`${browse}.scrollTo({ top: 0 })`);
  await wait(500);
  await cdp.eval(`(() => { const r = ${RECENT_FILMS}.getBoundingClientRect(); ${browse}.scrollBy({ top: r.top - 90 }); })()`);
  await wait(900);
  await park();
  await assert(`Boolean(${RECENT_SHOWS}) && Boolean(${RECENT_FILMS})`, 'Recently Added is not split into films and shows');
  await shot('13-films-and-shows.jpg', 'Recently Added Movies and TV Shows, kept apart');

  // 11. A show's own shelf: one card per season.
  const shelf = `document.querySelector('section.season-shelf')`;
  if (await cdp.eval(`Boolean(${shelf})`)) {
    await cdp.eval(`${shelf}.scrollIntoView({ block: 'center' })`);
    await wait(900);
    await park();
    await assert(`${shelf}.querySelectorAll('.season-tile img').length >= 2 && [...${shelf}.querySelectorAll('.season-tile img')].every(i => i.naturalWidth > 0)`, 'season cards without artwork');
    // Cropped to the heading and the cards: two seasons in a full-width strip is mostly
    // empty page, and shrinks to nothing in the README's table.
    const clip = await cdp.eval(`(() => {
      const r = ${shelf}.getBoundingClientRect();
      const words = (${shelf}.querySelector('.row-subtitle') ?? ${shelf}.querySelector('.row-title')).getBoundingClientRect();
      const cards = [...${shelf}.querySelectorAll('.season-tile')].map((t) => t.getBoundingClientRect().right);
      return { x: 0, y: Math.max(0, r.top - 12), width: Math.min(innerWidth, Math.max(words.right, ...cards) + 56), height: r.height + 24 };
    })()`);
    await shot('11-season-shelf.jpg', 'a series\' shelf, one card per season', clip);
  } else {
    console.log('  – 11-season-shelf.jpg       skipped: no show with two or more seasons');
  }

  // 12. The show's detail view, then 10. its episode list.
  await cdp.eval(`${browse}.scrollTo({ top: 0 })`);
  await wait(500);
  await cdp.eval(`${showTile}.scrollIntoView({ block: 'center' })`);
  await wait(500);
  await cdp.pointer(showTile, { click: true });
  await until(cdp, `document.querySelectorAll('.episode').length > 0`, { timeout: 15000 });
  await wait(2500);
  await park();
  // The title, next-up and Play live in the dialog's hero, not in `.modal-panel`.
  await assert(`Boolean(document.querySelector('.modal .nextup')) && Boolean(document.querySelector('.modal .play-button'))`, 'the show has no next-up or Play');
  await shot('12-show-detail.jpg', 'a show: next-up, creators, what it holds');

  await cdp.eval(`document.querySelector('.episodes').scrollIntoView({ block: 'start' })`);
  await wait(900);
  await park();
  // Just the list: the episode rows are the part of a show that has no film equivalent.
  const list = await cdp.eval(`(() => { const r = document.querySelector('.episodes').getBoundingClientRect(); return { x: r.left, y: Math.max(0, r.top), width: r.width, height: Math.min(r.height, innerHeight - Math.max(0, r.top)) }; })()`);
  // Stills are lazy: they load as the list scrolls into view, so wait for them.
  await until(cdp, `[...document.querySelectorAll('.episode .episode-still img')].slice(0, 3).every(i => i.complete && i.naturalWidth > 0)`, { timeout: 15000 });
  await shot('10-tv-episodes.jpg', "a show's seasons and episodes", list);
} else {
  console.log('  – 10–13                     skipped: this library holds no shows');
}

console.log(`\n${n} screenshots written to docs/screenshots/\n`);
cdp.close();
