import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scaleOverride, trafficLightsFor, uiScaleFor } from './ui-scale.js';

describe('the interface grows with the window', () => {
  test('the laptop it was designed on is untouched', () => {
    assert.equal(uiScaleFor(1512, 945), 1); // 14" MacBook Pro, maximised
    assert.equal(uiScaleFor(1512, 982), 1); // …and full screen
    assert.equal(uiScaleFor(1280, 820), 1); // the default window
    assert.equal(uiScaleFor(900, 600), 1); // the minimum window: never smaller than drawn
  });

  test('a 27" 2560×1440 monitor draws it half as large again (the report)', () => {
    assert.equal(uiScaleFor(2560, 1415), 1.5); // maximised, below the menu bar
    assert.equal(uiScaleFor(2560, 1440), 1.5); // full screen
  });

  test('a bigger laptop grows a little', () => {
    assert.equal(uiScaleFor(1728, 1080), 1.15); // 16" MacBook Pro
  });

  test('TVs: 4K at "looks like 1080p", and 4K at native resolution', () => {
    assert.equal(uiScaleFor(1920, 1055), 1.1);
    assert.equal(uiScaleFor(3840, 2135), 2.25);
  });

  test('an ultrawide is held by its height, not stretched by its width', () => {
    assert.equal(uiScaleFor(3440, 1415), 1.5);
  });

  test('capped, and stepped so a resize does not re-lay out on every pixel', () => {
    assert.equal(uiScaleFor(7680, 4320), 3);
    assert.equal(uiScaleFor(2100, 1350), uiScaleFor(2110, 1355)); // both 1.4
  });
});

describe('the traffic lights follow the nav', () => {
  test('at 1× they sit exactly where they were designed', () => {
    assert.deepEqual(trafficLightsFor(1), { x: 20, y: 20 });
  });

  test("their centre scales with the page, since they cannot", () => {
    const { x, y } = trafficLightsFor(1.5);
    assert.equal(x, 30);
    assert.equal(y + 7, Math.round(27 * 1.5)); // centre was 27 at 1×
  });
});

describe('a manual override', () => {
  test('a sane number is honoured; anything else is ignored', () => {
    assert.equal(scaleOverride('1.5'), 1.5);
    assert.equal(scaleOverride(undefined), null);
    assert.equal(scaleOverride(''), null);
    assert.equal(scaleOverride('huge'), null);
    assert.equal(scaleOverride('9'), null);
  });
});
