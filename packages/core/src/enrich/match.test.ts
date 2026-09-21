import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, runtimeSimilarity, scoreCandidate, titleSimilarity } from './match.js';
import type { TmdbCandidate } from './match.js';

const parsed = (over: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
  title: 'Film',
  year: 2020,
  originalYear: undefined,
  searchTitles: ['Film'],
  ...over,
});

const cand = (over: Partial<TmdbCandidate> = {}): TmdbCandidate => ({
  id: 1,
  title: 'Film',
  release_date: '2020-01-01',
  ...over,
});

describe('titleSimilarity', () => {
  test('ignores the punctuation scene naming strips', () => {
    // The scanner sees "Terminator 2 Judgment Day"; TMDB has the colon.
    assert.equal(titleSimilarity('Terminator 2 Judgment Day', 'Terminator 2: Judgment Day'), 1);
    assert.equal(titleSimilarity('John Wick Chapter 4', 'John Wick: Chapter 4'), 1);
  });

  test('treats a dropped subtitle generously, not as a mismatch', () => {
    // TMDB lists the 1977 film simply as "Star Wars".
    assert.ok(titleSimilarity('Star Wars Episode IV A New Hope', 'Star Wars') >= 0.9);
    assert.ok(titleSimilarity('Caligula', 'Caligula: The Ultimate Cut') >= 0.9);
  });

  test('still separates genuinely different films', () => {
    assert.ok(titleSimilarity('The Dark Knight', 'The Dark Knight Rises') < 1);
    assert.ok(titleSimilarity('Heat', 'Drive') < 0.5);
  });
});

describe('runtimeSimilarity', () => {
  test('corroborates a match using data the filename cannot give', () => {
    assert.equal(runtimeSimilarity(140 * 60, 140), 1);
    assert.equal(runtimeSimilarity(140 * 60, 141), 1);
  });

  test('a large gap suggests a different cut, not a different film', () => {
    // Theatrical vs Extended: same film, very different runtime.
    assert.ok(runtimeSimilarity(137 * 60, 154)! <= 0.3);
  });

  test('is neutral when TMDB has no runtime', () => {
    assert.equal(runtimeSimilarity(7200, undefined), null);
  });
});

describe('scoreCandidate', () => {
  test('a clean title and year match scores high', () => {
    const s = scoreCandidate(
      parsed({ title: 'The Dark Knight', year: 2008, searchTitles: ['The Dark Knight'] }),
      cand({ title: 'The Dark Knight', release_date: '2008-07-16' }),
      152 * 60,
      152,
    );
    assert.ok(s.score >= 0.9, `expected high score, got ${s.score}`);
    assert.ok(s.reasons.includes('title matches'));
    assert.ok(s.reasons.includes('year matches'));
  });

  test('accepts the original year of a re-cut', () => {
    // Caligula: The Ultimate Cut is a 2023 re-edit of a 1979 film; TMDB may list either.
    const s = scoreCandidate(
      parsed({ title: 'Caligula', year: 2023, originalYear: 1979, searchTitles: ['Caligula'] }),
      cand({ title: 'Caligula', release_date: '1979-08-14' }),
      156 * 60,
    );
    assert.equal(s.yearScore, 1);
    assert.ok(s.reasons.includes('year matches'));
  });

  test('a wrong year sinks an otherwise perfect title', () => {
    const s = scoreCandidate(
      parsed({ title: 'The Thing', year: 1982, searchTitles: ['The Thing'] }),
      cand({ title: 'The Thing', release_date: '2011-10-14' }),
      109 * 60,
    );
    assert.equal(s.yearScore, 0);
    assert.ok(s.score < 0.7);
  });

  test('runtime confirms but never overrules — an alternate cut is still the film', () => {
    const theatrical = scoreCandidate(
      parsed({ title: 'Blade Runner', year: 1982, searchTitles: ['Blade Runner'] }),
      cand({ title: 'Blade Runner', release_date: '1982-06-25' }),
      117 * 60, // Final Cut is longer than TMDB's listed runtime
      113,
    );
    assert.ok(theatrical.score >= 0.85, `alternate cut must still match: ${theatrical.score}`);
  });
});

describe('decide', () => {
  test('auto-accepts only when title and year are both convincing', () => {
    const s = scoreCandidate(
      parsed({ title: 'Batman Begins', year: 2005, searchTitles: ['Batman Begins'] }),
      cand({ title: 'Batman Begins', release_date: '2005-06-10' }),
      140 * 60,
      140,
    );
    assert.equal(decide([s]).verdict, 'auto');
  });

  test('a near-tie goes to review rather than guessing — this is the remake case', () => {
    const a = scoreCandidate(
      parsed({ title: 'The Thing', year: 1982, searchTitles: ['The Thing'] }),
      cand({ id: 1, title: 'The Thing', release_date: '1982-06-25' }),
      109 * 60,
      109,
    );
    const b = scoreCandidate(
      parsed({ title: 'The Thing', year: 1982, searchTitles: ['The Thing'] }),
      cand({ id: 2, title: 'The Thing', release_date: '1982-08-01' }),
      109 * 60,
      109,
    );
    assert.equal(decide([a, b]).verdict, 'review', 'two equally good candidates must be reviewed');
  });

  test('a shaky title goes to review even with a perfect year', () => {
    const s = scoreCandidate(
      parsed({ title: 'Caligula 1979 The', year: 2023, searchTitles: ['Caligula 1979 The'] }),
      cand({ title: 'Caligula: The Ultimate Cut', release_date: '2023-08-16' }),
      178 * 60,
    );
    assert.equal(decide([s]).verdict, 'review');
  });

  test('no candidates is reported, not crashed', () => {
    assert.deepEqual(decide([]), { best: null, runnersUp: [], verdict: 'none' });
  });
});
