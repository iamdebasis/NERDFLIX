import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TmdbClient, searchText } from './tmdb.js';

/**
 * TMDB's search returns NOTHING for decomposed Unicode. Found on a real drive: two
 * cartoons whose filenames carried "é" as "e" + a combining accent matched nothing,
 * while the same titles typed normally matched at once. The client composes every
 * query, so a title stored decomposed before the parser learned to compose still
 * searches correctly.
 */
describe('search queries go out composed', () => {
  const NFD = 'Tom And Chérie'.normalize('NFD');

  test('searchText composes', () => {
    assert.notEqual(NFD, NFD.normalize('NFC'), 'precondition: the fixture really is decomposed');
    assert.equal(searchText(NFD), 'Tom And Chérie'.normalize('NFC'));
  });

  test('the client sends the composed form, for films and for shows', async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: URL | string) => {
      sent.push(new URL(String(url)).searchParams.get('query') ?? '');
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new TmdbClient('token', '/nonexistent');
      await client.searchMovie(NFD);
      await client.searchTv(NFD);
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(sent, ['Tom And Chérie'.normalize('NFC'), 'Tom And Chérie'.normalize('NFC')]);
  });
});
