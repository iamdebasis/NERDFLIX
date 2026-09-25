import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { IinaEngine, IinaOtherPlayerError, isSameMedia } from './iina.js';
import { MpvIpc } from './mpv-ipc.js';

/**
 * Which IINA player the engine attaches to.
 *
 * Every IINA program binds the same socket path, `iina-cli` starts a new one per film,
 * and the previous film's IINA can still be running — window closed, idle — holding
 * that path. Observed on real hardware: every HDR remux reported "0x0, SDR, software
 * decode, audio device did not open", because the engine had attached to the leftover.
 *
 * The fake below speaks mpv's JSON IPC and binds its path the way mpv does — removing
 * whatever is there — so a second player takes the path over from the first.
 */
const FILM = '/Volumes/MOVIEX/Pirates.of.the.Caribbean.2011.UHD.BluRay.2160p.mkv';

type Props = Record<string, unknown>;

async function fakePlayer(socketPath: string, props: Props, log: string[] = []) {
  const clients = new Set<import('node:net').Socket>();
  const observed = new Map<string, number>();
  const server: Server = createServer((sock) => {
    clients.add(sock);
    sock.on('close', () => clients.delete(sock));
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as { command: unknown[]; request_id?: number };
        const [cmd, a, b] = msg.command as [string, unknown, unknown];
        log.push(cmd);
        const reply = (body: object) =>
          msg.request_id !== undefined && sock.write(JSON.stringify({ request_id: msg.request_id, ...body }) + '\n');
        if (cmd === 'get_property') {
          const v = props[a as string];
          reply(v === undefined ? { error: 'property unavailable' } : { error: 'success', data: v });
        } else if (cmd === 'observe_property') {
          observed.set(b as string, a as number);
          reply({ error: 'success' });
        } else if (cmd === 'quit') {
          reply({ error: 'success' });
          for (const c of clients) c.end();
          server.close();
        } else {
          reply({ error: 'success' });
        }
      }
    });
  });
  await unlink(socketPath).catch(() => {});
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    server,
    log,
    /** Push a property change to every connected client, as mpv does to observers. */
    change(name: string, data: unknown) {
      const id = observed.get(name);
      if (id === undefined) return false;
      for (const c of clients) c.write(JSON.stringify({ event: 'property-change', id, name, data }) + '\n');
      return true;
    },
    close() {
      for (const c of clients) c.destroy();
      server.close();
    },
  };
}

async function withSocket(fn: (socketPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nfl-iina-'));
  try {
    await fn(join(dir, 'iina.sock'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const engineFor = (socketPath: string, over: Partial<ConstructorParameters<typeof IinaEngine>[0]> = {}) =>
  // `/usr/bin/true` stands in for iina-cli: launching is not what is under test.
  new IinaEngine({ socketPath, cliPath: '/usr/bin/true', ...over });

describe('the IINA engine attaches to the player showing OUR film', () => {
  test('a leftover idle IINA holds the socket first — the engine waits for the new one', async () => {
    await withSocket(async (socketPath) => {
      const leftover = await fakePlayer(socketPath, { pid: 111, width: 0 });
      let fresh: Awaited<ReturnType<typeof fakePlayer>> | undefined;
      const takeover = setTimeout(async () => {
        fresh = await fakePlayer(socketPath, { pid: 222, path: FILM, width: 3840, height: 2160 });
      }, 800);
      const engine = engineFor(socketPath, { loadTimeoutMs: 15_000 });
      try {
        await engine.load(FILM);
        // Only the new player answers 3840: the leftover would have reported nothing.
        assert.equal(await engine.get('width'), 3840);
      } finally {
        clearTimeout(takeover);
        await engine.dispose();
        leftover.close();
        fresh?.close();
      }
    });
  });

  test('a player showing a DIFFERENT film is never attached — its position is not ours', async () => {
    await withSocket(async (socketPath) => {
      const other = await fakePlayer(socketPath, { path: '/Volumes/MOVIEX/Some.Other.Film.mkv', width: 1920 });
      const engine = engineFor(socketPath, { loadTimeoutMs: 2_500 });
      try {
        await assert.rejects(engine.load(FILM), IinaOtherPlayerError);
      } finally {
        other.close();
      }
    });
  });

  test('our own player, still opening a slow file, is waited for rather than read blank', async () => {
    await withSocket(async (socketPath) => {
      const props: Props = { path: FILM, width: 0 };
      const player = await fakePlayer(socketPath, props);
      const opened = setTimeout(() => (props.width = 3840), 1_000);
      const engine = engineFor(socketPath, { loadTimeoutMs: 10_000 });
      try {
        await engine.load(FILM);
        assert.equal(await engine.get('width'), 3840, 'the status would have read 0x0');
      } finally {
        clearTimeout(opened);
        await engine.dispose();
        player.close();
      }
    });
  });

  test('when our film window closes, that IINA is asked to quit — and the app hears the film end', async () => {
    await withSocket(async (socketPath) => {
      const player = await fakePlayer(socketPath, { path: FILM, width: 3840 });
      let ended = false;
      const engine = engineFor(socketPath, { loadTimeoutMs: 10_000, onExit: () => (ended = true) });
      await engine.load(FILM);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(player.change('idle-active', true), 'the engine never watched idle-active');
      await new Promise((r) => setTimeout(r, 2_200));
      assert.ok(player.log.includes('quit'), 'the idle IINA was left running, holding the socket');
      assert.equal(ended, true, 'the app was never told the film ended');
      player.close();
    });
  });

  test('a moment without a file is not a closed window', async () => {
    await withSocket(async (socketPath) => {
      const player = await fakePlayer(socketPath, { path: FILM, width: 3840 });
      const engine = engineFor(socketPath, { loadTimeoutMs: 10_000 });
      try {
        await engine.load(FILM);
        await new Promise((r) => setTimeout(r, 200));
        player.change('idle-active', true);
        await new Promise((r) => setTimeout(r, 400));
        player.change('idle-active', false);
        await new Promise((r) => setTimeout(r, 1_600));
        assert.equal(player.log.includes('quit'), false, 'quit a player between files');
      } finally {
        await engine.dispose();
        player.close();
      }
    });
  });
});

describe('isSameMedia', () => {
  test('the same path, and the same path decomposed', () => {
    assert.equal(isSameMedia(FILM, FILM), true);
    const nfc = '/Volumes/MOVIEX/Tom and Jerry - S1950E43 - Touché, Pussy Cat!.mkv';
    assert.equal(isSameMedia(nfc.normalize('NFD'), nfc), true);
  });

  test('a file:// URL for the same file', () => {
    assert.equal(isSameMedia('file:///Volumes/MOVIEX/A%20Film.mkv', '/Volumes/MOVIEX/A Film.mkv'), true);
  });

  test('another file, or nothing at all, is not ours', () => {
    assert.equal(isSameMedia('/Volumes/MOVIEX/Other.mkv', FILM), false);
    assert.equal(isSameMedia(null, FILM), false);
    assert.equal(isSameMedia('', FILM), false);
  });
});

describe('shutting a player down', () => {
  test('dispose waits until that IINA has actually exited — it deletes the socket as it goes', async () => {
    await withSocket(async (socketPath) => {
      // A real process stands in for IINA, and takes a moment to exit once told to quit.
      const iina = spawn('sleep', ['30'], { stdio: 'ignore' });
      const props: Props = { path: FILM, width: 3840, pid: iina.pid };
      const player = await fakePlayer(socketPath, props);
      const engine = engineFor(socketPath, { loadTimeoutMs: 10_000 });
      await engine.load(FILM);
      await new Promise((r) => setTimeout(r, 200)); // the pid is read asynchronously
      const exited = new Promise<void>((r) => iina.once('exit', () => r()));
      setTimeout(() => iina.kill(), 600); // "IINA" finishes shutting down 600ms after quit
      const t0 = Date.now();
      await engine.dispose();
      const took = Date.now() - t0;
      await exited;
      assert.ok(took >= 500, `dispose returned after ${took}ms, while that IINA was still running`);
      player.close();
    });
  });
});

describe('a player vanishing mid-request', () => {
  test('a socket error is not thrown — a quitting IINA must not take the app down', async () => {
    await withSocket(async (socketPath) => {
      const player = await fakePlayer(socketPath, { width: 3840 });
      const ipc = new MpvIpc(socketPath);
      await ipc.connect(2_000);
      try {
        // The socket error a write to a quitting IINA raises (EPIPE). It used to be
        // re-emitted as an 'error' nobody listened to, which Node THROWS — measured
        // taking the process down while connecting past a player that was shutting down.
        const socket = (ipc as unknown as { socket: import('node:net').Socket }).socket;
        assert.doesNotThrow(() => socket.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      } finally {
        ipc.close();
        player.close();
      }
    });
  });
});
