import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, normalizeTitle, cleanReleaseName } from './parse.js';

/**
 * These cases come from a real library. The first three pin regressions found on the
 * very first scan run — do not relax them without a replacement case.
 */

test('extracts year from UHD remux names (regression: TV mode ate the year)', () => {
  const r = parseRelease(
    'John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GHD[TGx]',
  );
  assert.equal(r.title, 'John Wick Chapter 4');
  assert.equal(r.year, 2023);
  assert.equal(r.isShow, false);
});

test('does not hallucinate seasons from year digits (regression: 2023 → S20E23)', () => {
  for (const name of [
    'John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX.HEVC-GHD',
    'Star.Wars.Episode.IV.A.New.Hope.1977.Hybrid.2160p.Remux.HEVC.DoVi.TrueHD.7.1-3L',
    'Terminator.2.Judgment.Day.1991.Theatrical.Cut.UHD.BluRay.2160p.HEVC.REMUX-FraMeSToR',
  ]) {
    const r = parseRelease(name);
    assert.equal(r.isShow, false, `${name} misdetected as TV`);
    assert.equal(r.seasons, undefined);
    assert.ok(r.year, `${name} lost its year`);
  }
});

test('edition excludes quality flags (regression: UHD/DolbyVision leaked as edition)', () => {
  const jw = parseRelease('John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX.DV.HDR10.HEVC-GHD');
  assert.equal(jw.edition, undefined);

  const t2 = parseRelease(
    'Terminator.2.Judgment.Day.1991.Theatrical.Cut.UHD.BluRay.2160p.HEVC.REMUX-FraMeSToR',
  );
  assert.equal(t2.edition, 'Theatrical Cut');
});

test('recognises non-standard scene editions', () => {
  // "Hybrid" is provenance, not a cut — it moved to releaseAttributes.
  const sw = parseRelease(
    'Star.Wars.Episode.IV.A.New.Hope.1977.Hybrid.2160p.Remux.HEVC.DoVi.TrueHD.7.1-3L',
  );
  assert.equal(sw.edition, undefined);
  assert.ok(sw.releaseAttributes.includes('Hybrid'));

  // These genuinely change what you watch, so they stay editions.
  assert.equal(parseRelease('Film.1999.Open.Matte.1080p.WEB-DL-GRP').edition, 'Open Matte');
  assert.equal(
    parseRelease('Star.Wars.1977.Despecialized.1080p.x264-TEAM').edition,
    'Despecialized',
  );
  assert.equal(parseRelease('Aliens.1986.IMAX.2160p.UHD.BluRay.REMUX-GRP').edition, 'IMAX');
});

test('strips tracker tags from the release group', () => {
  assert.equal(
    cleanReleaseName('John.Wick.Chapter.4.2023.HEVC-GHD[TGx]'),
    'John.Wick.Chapter.4.2023.HEVC-GHD',
  );
  const r = parseRelease('John.Wick.Chapter.4.2023.2160p.Bluray.REMUX.HEVC-GHD[TGx]');
  assert.equal(r.releaseGroup, 'GHD');
});

test('detects genuine TV releases', () => {
  const r = parseRelease('The.Mentalist.S01E01.1080p.BluRay.x264-GROUP');
  assert.equal(r.isShow, true);
  assert.deepEqual(r.seasons, [1]);
  assert.deepEqual(r.episodes, [1]);
});

test('normalizes titles for punctuation-insensitive matching', () => {
  // Scene naming eats colons; TMDB has "Terminator 2: Judgment Day".
  assert.equal(
    normalizeTitle('Terminator 2 Judgment Day'),
    normalizeTitle('Terminator 2: Judgment Day'),
  );
  assert.equal(normalizeTitle('John Wick Chapter 4'), normalizeTitle('John Wick: Chapter 4'));
});

// --- Regressions from the first real-library scan -------------------------------

test('strips embedded years and dangling articles (regression: "Caligula 1979 The")', () => {
  const r = parseRelease(
    'Caligula.1979.The.Ultimate.Cut.2023.Release.1080p.BluRay.DD.2CH.H264-BEN.THE.MEN',
  );
  assert.equal(r.title, 'Caligula');
  assert.equal(r.year, 2023);
  assert.equal(r.originalYear, 1979);
  assert.ok(r.warnings.includes('embedded-year'));
  assert.ok(r.warnings.includes('dangling-article'));
  assert.equal(r.lowConfidence, true, 'a mangled title must route to review');
});

test('reads the literal edition phrase (regression: "Ultimate Cut" reported as Extended)', () => {
  const caligula = parseRelease('Caligula.1979.The.Ultimate.Cut.2023.Release.1080p.BluRay-BEN');
  assert.equal(caligula.edition, 'Ultimate Cut');

  const blade = parseRelease('Blade.Runner.1982.Final.Cut.2160p.UHD.BluRay.REMUX.HEVC-GRP');
  assert.equal(blade.edition, 'Final Cut');

  const dc = parseRelease('Watchmen.2009.Directors.Cut.1080p.BluRay.x264-GRP');
  assert.equal(dc.edition, "Director's Cut");
});

test('offers edition-qualified search candidates for re-cuts', () => {
  const r = parseRelease('Caligula.1979.The.Ultimate.Cut.2023.Release.1080p.BluRay-BEN');
  // TMDB lists this as "Caligula: The Ultimate Cut", so the bare title alone may miss.
  assert.ok(r.searchTitles.includes('Caligula'));
  assert.ok(r.searchTitles.some((t) => /ultimate/i.test(t)));
});

test('clean releases produce no warnings', () => {
  for (const name of [
    'John.Wick.Chapter.4.2023.2160p.UHD.Bluray.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-GHD[TGx]',
    'Star.Wars.Episode.IV.A.New.Hope.1977.Hybrid.2160p.Remux.HEVC.DoVi.TrueHD.7.1-3L',
    'Terminator.2.Judgment.Day.1991.Theatrical.Cut.UHD.BluRay.2160p.DTS-HD.MA.5.1.HEVC.REMUX-FraMeSToR',
  ]) {
    const r = parseRelease(name);
    assert.deepEqual(r.warnings, [], `${name} should be clean, got ${r.warnings.join(',')}`);
  }
});

// --- Regressions from the MOVIEX (Nolan Batman) scan ----------------------------

test('HYBRID is release provenance, not an edition (regression: all 3 Nolan films)', () => {
  for (const name of [
    'Batman.Begins.2005.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR',
    'The.Dark.Knight.2008.UHD.BluRay.2160p.TrueHD.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR',
    'The.Dark.Knight.Rises.2012.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR',
  ]) {
    const r = parseRelease(name);
    assert.equal(r.edition, undefined, `${name}: HYBRID must not become an edition`);
    assert.ok(r.releaseAttributes.includes('Hybrid'));
    assert.deepEqual(r.warnings, []);
  }
});

test('Nolan Batman titles and years parse cleanly', () => {
  const cases: Array<[string, string, number]> = [
    ['Batman.Begins.2005.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR', 'Batman Begins', 2005],
    ['The.Dark.Knight.2008.UHD.BluRay.2160p.TrueHD.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR', 'The Dark Knight', 2008],
    ['The.Dark.Knight.Rises.2012.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR', 'The Dark Knight Rises', 2012],
  ];
  for (const [name, title, year] of cases) {
    const r = parseRelease(name);
    assert.equal(r.title, title);
    assert.equal(r.year, year);
    assert.equal(r.releaseGroup, 'FraMeSToR');
  }
});

test('a real edition still beats a release attribute', () => {
  // Hybrid + a genuine cut: the cut goes to edition, Hybrid stays an attribute.
  const r = parseRelease('Some.Film.1999.Directors.Cut.2160p.UHD.BluRay.HEVC.HYBRID.REMUX-GRP');
  assert.equal(r.edition, "Director's Cut");
  assert.ok(r.releaseAttributes.includes('Hybrid'));
});
