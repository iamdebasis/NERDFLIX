# docs/

`screenshots/` — captured from the running app, referenced by the root README.

## Regenerating them

```bash
pnpm app:debug            # terminal 1 — the app with its debugger open on :9222
pnpm screenshots          # terminal 2
```

`scripts/screenshots.mjs` drives the real UI over the Chrome DevTools Protocol rather
than posing it by hand, so what the README shows is what the app actually renders.

Three rules it follows, each because a capture came back wrong without it:

- **Every shot asserts the DOM is in the state it claims**, and waits on that state
  rather than on a stopwatch. A capture that quietly got an empty modal, or a billboard
  whose trailer never started, is a claim about the product that nobody checked.
- **The pointer is parked before any shot that is not about hovering.** It stays wherever
  the last click left it, so scrolling a row under it opens a hover card — which is how
  the collection-rows shot came back with its row title covered by a preview of
  something else.
- **Trailer shots wait out YouTube's opening chrome.** `.trailer-video.is-playing` only
  means the app has revealed the frame; YouTube's transport controls and title bar fade
  on their own schedule, measured as gone by five seconds. Capturing before then puts a
  pause button in the middle of the billboard. The preview player needs waiting for
  *specifically* — `.trailer-video` also exists inside the hero, so a looser selector
  matches the billboard's frame and resolves instantly.

Clicks use real `Input.dispatchMouseEvent` calls, not `element.click()`. The nav is a
window drag region, and a programmatic click ignores `-webkit-app-region` entirely — it
would pass happily against a control that is dead to an actual pointer.

The script reloads the page first, because the app keeps whatever view, search and
filters it was left in and a second run would otherwise start inside the library.

Captures arrive at the display's device pixel ratio — 2560px wide on a Retina panel —
and are downscaled to 1600px with `sips`, which ships with macOS.
