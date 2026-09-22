/**
 * Regenerate docs/screenshots/ by driving the running app.
 *
 *   pnpm app:debug          # terminal 1 — the app, with its debugger open
 *   pnpm screenshots        # terminal 2
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

async function shot(file, description) {
  const target = join(OUT, file);
  await writeFile(target, await cdp.screenshot({ quality: 92 }));
  await run('sips', ['--resampleWidth', String(WIDTH), '-s', 'format', 'jpeg',
                     '-s', 'formatOptions', '80', target, '--out', target]);
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
const combined = `[...document.querySelectorAll('button.card')].find(b => b.innerText.includes('All films'))`;
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
await until(cdp, `Boolean(document.querySelector('.trailer-video.is-playing'))`, { timeout: 40000 });
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
await cdp.pointer(`${ROW('Recently Added')}.querySelectorAll('.tile')[2]`);
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
await cdp.pointer(`${ROW('Recently Added')}.querySelectorAll('.tile')[2]`, { click: true });
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

console.log(`\n${n} screenshots written to docs/screenshots/\n`);
cdp.close();
