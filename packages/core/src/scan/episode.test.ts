import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanSeriesName,
  episodeLabel,
  hasEpisodeMarker,
  parseEpisode,
  parseSeasonPack,
  seasonFromFolder,
  seriesFromFolders,
  isYearSeason,
} from './episode.js';
import { parseRelease } from './parse.js';
import { looksLikeFeature } from './junk.js';

/**
 * A film read as an episode vanishes from the film shelves, and an episode read as a
 * film becomes a junk title with someone else's poster. Both directions are pinned.
 */

describe('films are never episodes', () => {
  for (const name of [
    // The parser library's TV mode reads this one as episode 4 of "Star Wars".
    'Star.Wars.Episode.4.A.New.Hope.1977.2160p.UHD.BluRay.REMUX-GRP',
    'Star.Wars.Episode.IV.A.New.Hope.1977.Hybrid.2160p.Remux.HEVC.DoVi.TrueHD.7.1-3L',
    'John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX.HEVC-GHD',
    'Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX-GRP',
    '1917.2019.2160p.UHD.BluRay.REMUX-GRP',
    '2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.REMUX-GRP',
    // A real film whose title is NxNN.
    '10x10.2018.1080p.BluRay.x264-GRP',
    // Resolution-shaped tokens.
    'Some.Film.2020.1920x1080.BluRay',
    'Terminator.2.Judgment.Day.1991.Theatrical.Cut.UHD.BluRay.2160p.HEVC.REMUX-FraMeSToR',
    // Year-shaped seasons are accepted only in explicit context. These are films.
    'Open.Season.2006.1080p.BluRay.x264-GRP',
    'Summer.of.1942.1971.1080p.BluRay.x264-GRP',
    'Apollo.13.1995.2160p.UHD.BluRay.REMUX-GRP',
  ]) {
    test(name, () => assert.equal(parseEpisode(name), null));
  }

  test('a numbered file is only an episode DIRECTLY inside a season folder', () => {
    // Two levels down is a featurette or a film in an oddly named shelf, not an episode.
    assert.equal(parseEpisode('03 - Making Of', ['Show', 'Season 01', 'Extras']), null);
    assert.equal(parseEpisode('1917.2019.2160p', ['Films']), null);
  });
});

describe('episode markers', () => {
  test('SxxEyy with series, title and group', () => {
    const e = parseEpisode('Breaking.Bad.S01E01.Pilot.2160p.NF.WEB-DL.DDP5.1.HDR.HEVC-GRP');
    assert.deepEqual(
      { series: e?.series, season: e?.season, episode: e?.episode, title: e?.episodeTitle },
      { series: 'Breaking Bad', season: 1, episode: 1, title: 'Pilot' },
    );
    assert.equal(e?.seriesSource, 'name');
  });

  test('lowercase and spaced forms', () => {
    assert.equal(parseEpisode('the.wire.s03e11.mkv')?.episode, 11);
    assert.equal(parseEpisode('Game of Thrones - S01E01 - Winter Is Coming')?.episodeTitle, 'Winter Is Coming');
    assert.equal(parseEpisode('Show S1 E5 1080p')?.episode, 5);
  });

  test('a hyphenated episode title survives (regression: "Seven Thirty-Seven" cut short)', () => {
    assert.equal(parseEpisode('Breaking Bad - S02E01 - Seven Thirty-Seven')?.episodeTitle, 'Seven Thirty-Seven');
    assert.equal(parseEpisode('Breaking.Bad.S02E01.Seven.Thirty-Seven.720p.HDTV-CTU')?.episodeTitle, 'Seven Thirty-Seven');
    // …while a group glued straight onto the title is still removed.
    assert.equal(parseEpisode('Show.S01E01.Pilot-GRP')?.episodeTitle, 'Pilot');
  });

  test('NxNN when a series names it', () => {
    const e = parseEpisode('Band.of.Brothers.1x04.Replacements.1080p.BluRay.x264');
    assert.deepEqual([e?.series, e?.season, e?.episode], ['Band of Brothers', 1, 4]);
  });

  describe('double episodes', () => {
    for (const [name, end] of [
      ['Game.of.Thrones.S08E01E02.2160p.UHD.BluRay.REMUX-GRP', 2],
      ['Show.S01E01-E02.1080p', 2],
      ['Show.S01E01-02.1080p', 2],
      ['Show.S01E01E02E03.1080p', 3],
    ] as const) {
      test(name, () => {
        const e = parseEpisode(name);
        assert.equal(e?.episode, 1);
        assert.equal(e?.episodeEnd, end);
      });
    }

    test('a resolution after the marker is not a range', () => {
      assert.equal(parseEpisode('Show.S01E01.2160p.WEB')?.episodeEnd, undefined);
      assert.equal(parseEpisode('Show.S02E03 - 720p')?.episodeEnd, undefined);
      assert.equal(parseEpisode('Show.S01E01-720p')?.episodeEnd, undefined);
    });
  });

  test('specials are season 0', () => {
    assert.equal(parseEpisode('Doctor.Who.S00E05.1080p')?.season, 0);
  });

  test('episode 0 and absurd numbers are rejected', () => {
    assert.equal(parseEpisode('Show.S01E00.1080p'), null);
  });
});

describe('series name, year and country', () => {
  test('a year in the name is the series year', () => {
    const e = parseEpisode('Severance.2022.S01E01.2160p.ATVP.WEB-DL');
    assert.deepEqual([e?.series, e?.seriesYear], ['Severance', 2022]);
  });

  test('a scene country suffix is kept as a hint, with UK mapped to GB', () => {
    assert.deepEqual(
      [parseEpisode('The.Office.US.S02E03.1080p')?.series, parseEpisode('The.Office.US.S02E03.1080p')?.country],
      ['The Office', 'US'],
    );
    assert.equal(parseEpisode('The.Office.UK.S01E01.1080p')?.country, 'GB');
  });

  test('a series named after a year keeps its name', () => {
    assert.deepEqual(cleanSeriesName('1923'), { name: '1923', year: undefined, country: undefined });
  });

  test('year and country in either order', () => {
    assert.deepEqual(cleanSeriesName('Doctor Who (2005) UK'), { name: 'Doctor Who', year: 2005, country: 'GB' });
    assert.deepEqual(cleanSeriesName('The.Office.US.2005'), { name: 'The Office', year: 2005, country: 'US' });
  });
});

describe('folders supply what the name does not', () => {
  test('a bare S01E01 file takes the series from its show folder', () => {
    const e = parseEpisode('S01E01', ['Breaking Bad (2008)', 'Season 01']);
    assert.deepEqual([e?.series, e?.seriesYear, e?.seriesSource], ['Breaking Bad', 2008, 'folder']);
  });

  test('a season-pack folder names the series', () => {
    const e = parseEpisode('s01e03', ['Chernobyl.S01.2160p.UHD.BluRay.REMUX-GRP']);
    assert.deepEqual([e?.series, e?.season, e?.episode], ['Chernobyl', 1, 3]);
  });

  test('a numbered file directly inside a season folder', () => {
    const e = parseEpisode('03 - The Replacements', ['Band of Brothers', 'Season 1']);
    assert.deepEqual([e?.series, e?.season, e?.episode, e?.episodeTitle], ['Band of Brothers', 1, 3, 'The Replacements']);
  });

  test('generic library folders are never a series', () => {
    assert.equal(parseEpisode('S01E01', ['TV Shows', 'Season 01'])?.series, '');
  });

  test('the folder year fills in when the file names the same series', () => {
    const e = parseEpisode('The.Office.S02E03.1080p', ['The Office (2005)', 'Season 02']);
    assert.equal(e?.seriesYear, 2005);
  });

  test('a folder for a DIFFERENT series lends nothing', () => {
    const e = parseEpisode('Chernobyl.S01E01.1080p', ['Box Sets (2019)']);
    assert.equal(e?.seriesYear, undefined);
  });
});

describe('season folders and packs', () => {
  test('seasonFromFolder', () => {
    assert.equal(seasonFromFolder('Season 01'), 1);
    assert.equal(seasonFromFolder('season.3'), 3);
    assert.equal(seasonFromFolder('S2'), 2);
    assert.equal(seasonFromFolder('Series 4'), 4);
    assert.equal(seasonFromFolder('Specials'), 0);
    assert.equal(seasonFromFolder('Season Pass'), null);
    assert.equal(seasonFromFolder('Breaking Bad'), null);
  });

  test('parseSeasonPack', () => {
    assert.deepEqual(parseSeasonPack('Breaking.Bad.S01.2160p.NF.WEB-DL-GRP'), { series: 'Breaking Bad', season: 1 });
    assert.deepEqual(parseSeasonPack('Chernobyl.S01.COMPLETE.2160p'), { series: 'Chernobyl', season: 1 });
    assert.deepEqual(parseSeasonPack('The Wire Season 3'), { series: 'The Wire', season: 3 });
    // An episode folder is not a pack.
    assert.equal(parseSeasonPack('Show.S01E01.1080p'), null);
  });

  test('seriesFromFolders reads a per-episode release folder', () => {
    assert.equal(seriesFromFolders(['Chernobyl.S01E02.2160p-GRP'])?.name, 'Chernobyl');
  });
});

describe('series numbered by year', () => {
  // The real names, in the real folder, from the library this was built against.
  const PACK = 'Tom and Jerry - Season 1940 Complete 1080p WEB x264 [i_c]';

  test('S1940E01 is season 1940, episode 1, with its title', () => {
    const e = parseEpisode('Tom and Jerry - S1940E01 - Puss Gets The Boot', [PACK]);
    assert.deepEqual(
      [e?.series, e?.seriesSource, e?.season, e?.episode, e?.episodeTitle],
      ['Tom and Jerry', 'name', 1940, 1, 'Puss Gets The Boot'],
    );
  });

  test('punctuation in the title survives', () => {
    assert.equal(parseEpisode('Tom and Jerry - S1940E22 - Quiet Please!', [PACK])?.episodeTitle, 'Quiet Please!');
    assert.equal(parseEpisode("Tom and Jerry - S1940E06 - Puss N' Toots", [PACK])?.episodeTitle, "Puss N' Toots");
  });

  test('a bare S1940E46 takes the series from the pack folder', () => {
    const e = parseEpisode('S1940E46 - Tennis Chumps', [PACK]);
    assert.deepEqual([e?.series, e?.season, e?.episode], ['Tom and Jerry', 1940, 46]);
  });

  test('a numbered file directly inside a "Season 1940" folder', () => {
    const e = parseEpisode('05 - Dog Trouble', ['Tom and Jerry', 'Season 1940']);
    assert.deepEqual([e?.series, e?.season, e?.episode], ['Tom and Jerry', 1940, 5]);
  });

  test('folders and packs read the year', () => {
    assert.equal(seasonFromFolder('Season 1940'), 1940);
    assert.equal(seasonFromFolder('S1940'), 1940);
    assert.deepEqual(parseSeasonPack(PACK), { series: 'Tom and Jerry', season: 1940 });
  });

  test('only years that could be years — three digits or 1850 is not a season', () => {
    assert.equal(parseEpisode('Show.S150E01.1080p'), null);
    assert.equal(parseEpisode('Show.S1850E01.1080p'), null);
    assert.equal(isYearSeason(1940), true);
    assert.equal(isYearSeason(12), false);
  });

  test('the whole release reads as an episode, and a year-titled film does not', () => {
    assert.equal(parseRelease('Tom and Jerry - S1940E03 - The Night Before Christmas', [PACK]).episode?.episode, 3);
    const film = parseRelease('Open.Season.2006.1080p.BluRay.x264-GRP');
    assert.equal(film.episode, undefined);
    assert.equal(film.warnings.includes('tv-without-episode'), false, 'Open Season is a film, not unplaced TV');
  });

  test('a short cartoon passes the episode size floor, not the film one', () => {
    const cartoon = 'Tom and Jerry - S1940E01 - Puss Gets The Boot.mkv';
    assert.equal(looksLikeFeature(cartoon, 60 * 1024 * 1024), true);
    assert.equal(looksLikeFeature('Some.Short.Film.1940.mkv', 60 * 1024 * 1024), false);
  });

  test('a decomposed name off a macOS disk comes out composed — TMDB cannot search the other', () => {
    // The real case: "Touché" stored as "e" + U+0301, which looks identical and is not.
    const nfd = 'Tom and Jerry - S1950E43 - Touché, Pussy Cat!'.normalize('NFD');
    const pack = 'Tom and Jerry - Season 1950 Complete 1080p WEB x264 [i_c]'.normalize('NFD');
    assert.notEqual(nfd, nfd.normalize('NFC'), 'precondition: the fixture really is decomposed');
    const e = parseEpisode(nfd, [pack]);
    assert.equal(e?.episodeTitle, 'Touché, Pussy Cat!'.normalize('NFC'));
    assert.equal(parseRelease(nfd, [pack]).episode?.episodeTitle, 'Touché, Pussy Cat!'.normalize('NFC'));
  });

  test('a decomposed folder and a composed file name the same show', () => {
    const e = parseEpisode('S01E01', ['Pokémon'.normalize('NFD'), 'Season 1']);
    assert.equal(e?.series, 'Pokémon'.normalize('NFC'));
  });

  test('a decomposed film title comes out composed too', () => {
    const t = parseRelease('Amélie.2001.1080p.BluRay.x264-GRP'.normalize('NFD')).title;
    assert.equal(t, t.normalize('NFC'));
    assert.match(t, /Amélie/);
  });

  test('labels keep the season as the file names it', () => {
    assert.equal(episodeLabel({ season: 1940, episode: 1 }), 'S1940:E1');
  });
});

describe('helpers', () => {
  test('hasEpisodeMarker', () => {
    assert.equal(hasEpisodeMarker('Show.S01E01.1080p.mkv'), true);
    assert.equal(hasEpisodeMarker('Star.Wars.Episode.4.mkv'), false);
  });

  test('episodeLabel uses Netflix short form', () => {
    assert.equal(episodeLabel({ season: 1, episode: 4 }), 'S1:E4');
    assert.equal(episodeLabel({ season: 8, episode: 1, episodeEnd: 2 }), 'S8:E1–E2');
    assert.equal(episodeLabel({ season: 0, episode: 3 }), 'Special 3');
  });
});
