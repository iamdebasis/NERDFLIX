import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decideShow, scoreShowCandidate, type ShowQuery } from './match.js';
import type { TmdbShowCandidate } from './tmdb.js';

/**
 * Shaped like real `/search/tv` responses. The Office is the case that matters: at
 * least three series share the name, and the US one is by far the most popular — so a
 * matcher that leant on popularity would quietly give every UK viewer the wrong show.
 */
const OFFICE: TmdbShowCandidate[] = [
  { id: 2316, name: 'The Office', first_air_date: '2005-03-24', origin_country: ['US'], popularity: 300 },
  { id: 2996, name: 'The Office', first_air_date: '2001-07-09', origin_country: ['GB'], popularity: 60 },
  { id: 218539, name: 'The Office', first_air_date: '2024-10-18', origin_country: ['AU'], popularity: 20 },
];

const decide = (q: ShowQuery, results: TmdbShowCandidate[]) =>
  decideShow(results.map((c) => scoreShowCandidate(q, c)));

describe('TV matching', () => {
  test('a name that belongs to one series is safe without a year', () => {
    const d = decide({ series: 'Breaking Bad' }, [
      { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', origin_country: ['US'] },
      { id: 999, name: 'Breaking Bad: Original Minisodes', first_air_date: '2009-01-01' },
    ]);
    assert.equal(d.verdict, 'auto');
    assert.equal(d.best?.candidate.id, 1396);
  });

  test('a shared name with nothing to separate them goes to review — never to the popular one', () => {
    const d = decide({ series: 'The Office' }, OFFICE);
    assert.equal(d.verdict, 'review');
  });

  test('a country suffix separates them', () => {
    assert.equal(decide({ series: 'The Office', country: 'GB' }, OFFICE).best?.candidate.id, 2996);
    assert.equal(decide({ series: 'The Office', country: 'GB' }, OFFICE).verdict, 'auto');
    assert.equal(decide({ series: 'The Office', country: 'US' }, OFFICE).best?.candidate.id, 2316);
  });

  test('a year separates them too', () => {
    const d = decide({ series: 'The Office', year: 2001 }, OFFICE);
    assert.deepEqual([d.best?.candidate.id, d.verdict], [2996, 'auto']);
  });

  test('a year that contradicts the only match is not accepted', () => {
    const d = decide({ series: 'Chernobyl', year: 1986 }, [
      { id: 87108, name: 'Chernobyl', first_air_date: '2019-05-06', origin_country: ['GB', 'US'] },
    ]);
    assert.equal(d.verdict, 'review');
  });

  test('a wrong-country match is never auto-accepted', () => {
    const d = decide({ series: 'The Office', country: 'NZ' }, OFFICE);
    assert.equal(d.verdict, 'review');
  });

  test('scene punctuation does not matter', () => {
    const d = decide({ series: 'Marvels Daredevil' }, [
      { id: 61889, name: "Marvel's Daredevil", first_air_date: '2015-04-10' },
    ]);
    assert.equal(d.verdict, 'auto');
  });

  test('a prefix match is a spin-off, not the show (Star Wars vs The Clone Wars)', () => {
    const d = decide({ series: 'Star Wars' }, [
      { id: 4194, name: 'Star Wars: The Clone Wars', first_air_date: '2008-10-03' },
      { id: 83867, name: 'Star Wars: Andor', first_air_date: '2022-09-21' },
    ]);
    assert.equal(d.verdict, 'review');
  });

  test('nothing found', () => {
    assert.equal(decide({ series: 'x' }, []).verdict, 'none');
  });
});
