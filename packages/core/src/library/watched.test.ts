import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { creditsStartSec, watchedFromSec } from './watched.js';
import { StateStore } from '../store/state-store.js';

/** Chapters at a percentage of a 10 000-second file, as measured on a real library. */
const D = 10_000;
const at = (pct: number, title: string) => ({ title, startSec: (pct / 100) * D });

describe('where the end credits begin', () => {
  // Chapter names and positions from the real remuxes this rule was written against.
  const cases: Array<[string, Array<{ title: string; startSec: number }>, number | null]> = [
    ['Curse of the Black Pearl', [at(75.6, 'The Trojan Horse'), at(93.0, 'End Credits')], 93.0],
    ["Dead Man's Chest", [at(90.5, '27. "Something to Trade"'), at(93.6, '28. Credits')], 93.6],
    ["At World's End", [at(91.7, 'Egregious'), at(94.2, 'Credits')], 94.2],
    ['Back to the Future', [at(91.9, 'Future Shock'), at(96.0, 'Roads? (Credits)')], 96.0],
    ['numbered chapters say nothing', [at(91.8, 'Chapter 19'), at(97.0, 'Chapter 20')], null],
    ['timestamps say nothing', [at(92.0, '02:03:15.596'), at(93.8, '02:05:42.118')], null],
  ];
  for (const [name, chapters, pct] of cases) {
    test(name, () => {
      const got = creditsStartSec(chapters, D);
      assert.equal(got === null ? null : Math.round((got / D) * 1000) / 10, pct);
    });
  }

  test('opening credits are not the end', () => {
    assert.equal(creditsStartSec([at(0.5, 'Opening Credits'), at(40, 'Chapter 5')], D), null);
  });

  test('a credits chapter mid-film is not the end either', () => {
    assert.equal(creditsStartSec([at(50, 'Credits Roll On The Ship')], D), null);
  });

  test('a mid-credits scene is not where the credits begin — the first credits chapter is', () => {
    const chapters = [at(92, 'End Credits'), at(95, 'Mid-Credits Scene'), at(96, 'End Credits')];
    assert.equal(creditsStartSec(chapters, D), at(92, '').startSec);
  });

  test('a lone post-credits scene says nothing about where the credits start', () => {
    assert.equal(creditsStartSec([at(98, 'Post-Credits Scene')], D), null);
  });
});

describe('watched from', () => {
  test('the start of the credits, when earlier than the final 5%', () => {
    assert.equal(watchedFromSec(D, [at(93.0, 'End Credits')]), at(93.0, '').startSec);
  });

  test('never later than the final 5%, even when the credits start later', () => {
    assert.equal(watchedFromSec(D, [at(96.0, 'Roads? (Credits)')]), 0.95 * D);
  });

  test('the final 5% without a credits chapter', () => {
    assert.equal(watchedFromSec(D, []), 0.95 * D);
  });
});

describe('closing at the credits marks it watched', () => {
  const withStore = async (fn: (s: StateStore, path: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'nfl-watched-'));
    try {
      const path = join(dir, 'progress.json');
      await fn(new StateStore(path), path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test('a film closed a few seconds into its credits at 93% is finished', async () => {
    await withStore(async (s, path) => {
      const from = watchedFromSec(D, [at(93.0, 'End Credits')]);
      await s.setProgress('curse-2003', from + 5, D, 0, from);
      await s.settle();
      assert.equal(JSON.parse(await readFile(path, 'utf8')).progress['curse-2003'].watched, true);
    });
  });

  test('the same film closed just before its credits is still in progress', async () => {
    await withStore(async (s, path) => {
      const from = watchedFromSec(D, [at(93.0, 'End Credits')]);
      await s.setProgress('curse-2003', from - 30, D, 0, from);
      await s.settle();
      const p = JSON.parse(await readFile(path, 'utf8')).progress['curse-2003'];
      assert.deepEqual([p.watched, Math.round(p.positionSec)], [false, Math.round(from - 30)]);
    });
  });

  test('an episode closed at its credits is finished, so Play moves on', async () => {
    await withStore(async (s, path) => {
      const from = watchedFromSec(3600, [{ title: 'End Credits', startSec: 3460 }]);
      await s.setEpisodeProgress('show-x', 'c-e4', 3470, 3600, from);
      await s.settle();
      const onDisk = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(onDisk.episodes['c-e4'].watched, true);
      assert.equal(onDisk.progress['show-x'].watched, true);
    });
  });

  test('without a threshold from the caller, 95% still counts — 96% of a file with no chapters', async () => {
    await withStore(async (s, path) => {
      await s.setProgress('film', 0.96 * D, D);
      await s.settle();
      assert.equal(JSON.parse(await readFile(path, 'utf8')).progress.film.watched, true);
    });
  });
});
