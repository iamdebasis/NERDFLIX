#!/usr/bin/env tsx
/**
 * pnpm play <file> [--start=SECONDS] [--no-hdr] [--headless]
 *
 * Milestone 2 harness. No UI, no Electron — this exists to prove that a 4K REMUX
 * plays at full bitrate under Node's control, with responsive seeking and correct
 * property reporting. If this feels right, the risky part of the project is done.
 *
 * Keys:  space play/pause   ← / → seek ∓10s   ↑ / ↓ seek ∓60s   m mute   q quit
 */

import {
  DEFAULT_IINA_SOCKET,
  ExternalMpvEngine,
  IinaEngine,
  findIinaCli,
  QUALITY_TIERS,
  formatStatus,
  readPlaybackStatus,
} from '@nfl/player';
import type { MpvTrack, QualityTier } from '@nfl/player';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};

function fmtTime(sec: number | null): string {
  if (sec === null || Number.isNaN(sec)) return '--:--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function bar(pos: number, dur: number, width = 36): string {
  if (!dur) return ' '.repeat(width);
  const filled = Math.round((pos / dur) * width);
  return '━'.repeat(Math.max(0, filled)) + C.dim + '─'.repeat(Math.max(0, width - filled)) + C.reset;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'usage: pnpm play <file> [--start=SECONDS] [--no-hdr] [--headless]\n' +
        '       [--quality=efficient|balanced|high|reference] [--motion|--no-motion]\n' +
        '       [--channels=stereo|auto-safe|auto] [--ao=avfoundation|coreaudio]\n' +
        '       [--peak=NITS]  HDR target luminance, e.g. 1600 for an XDR panel\n' +
        '       [--gpu-context=macvk]  force the Metal path; OpenGL cannot do HDR on macOS\n' +
        '       [--mpv-player]  force bare mpv instead of IINA\n' +
        '       [--metal]  render via mpv\'s native Swift/Metal backend (cocoa-cb)\n' +
        '       [--mpv="--flag=a --flag=b"]  raw mpv flags, passed through unfiltered\n' +
        '       [--no-adapt] [--cache=512MiB]',
    );
    process.exit(1);
  }
  // Check the file exists before spawning mpv. "mpv failed to open the file" tells
  // you nothing about WHICH file or WHY — and an abbreviated path pasted from
  // documentation (`Batman.Begins...mkv`) fails exactly this way.
  const { access } = await import('node:fs/promises');
  try {
    await access(file);
  } catch {
    console.error(`\n${C.red}No such file:${C.reset} ${file}\n`);
    if (file.includes('...')) {
      console.error(
        `${C.yellow}That path contains "..." — it looks like an abbreviation, not a real name.${C.reset}`,
      );
    }
    const { dirname, basename } = await import('node:path');
    const { readdir } = await import('node:fs/promises');
    try {
      const stem = basename(file).split(/[.\s]/)[0].toLowerCase();
      const siblings = (await readdir(dirname(file)))
        .filter((f) => /\.(mkv|mp4|m4v)$/i.test(f))
        .filter((f) => !stem || f.toLowerCase().startsWith(stem));
      if (siblings.length) {
        console.error(`\n${C.dim}Did you mean:${C.reset}`);
        for (const s of siblings.slice(0, 5)) {
          console.error(`  ${dirname(file)}/${s}`);
        }
      }
    } catch {
      /* directory unreadable too */
    }
    console.error('');
    process.exit(1);
  }

  const startArg = args.find((a) => a.startsWith('--start='));
  const startAt = startArg ? Number(startArg.split('=')[1]) : undefined;

  const cacheArg = args.find((a) => a.startsWith('--cache='));
  const qualityArg = args.find((a) => a.startsWith('--quality='));
  const channelsArg = args.find((a) => a.startsWith('--channels='));
  const aoArg = args.find((a) => a.startsWith('--ao='));
  const peakArg = args.find((a) => a.startsWith('--peak='));
  const ctxArg = args.find((a) => a.startsWith('--gpu-context='));
  // Everything inside --mpv="..." is handed to mpv untouched, so any combination can
  // be tried without a rebuild.
  const rawArg = args.find((a) => a.startsWith('--mpv='));
  /**
   * IINA renders better HDR on Apple silicon than mpv can be configured into, so it is
   * preferred when installed. `--mpv` forces the bare-mpv path for A/B comparison.
   */
  const wantsMpv = args.includes('--mpv-player');
  const iinaCli = wantsMpv ? null : await findIinaCli();

  if (iinaCli) {
    const iina = new IinaEngine({
      socketPath: process.env.NFL_IINA_SOCKET ?? DEFAULT_IINA_SOCKET,
    });
    await iina.start();
    console.log(`\n${C.bold}${file.split('/').pop()}${C.reset}`);
    await iina.load(file, { startAt: startArg ? Number(startArg.split('=')[1]) : undefined });
    iina.play();
    for (const line of formatStatus(await readPlaybackStatus(iina, { renderer: 'host' })))
      console.log(line);
    console.log(`  ${C.dim}rendering: IINA${C.reset}\n`);
    console.log(`  ${C.dim}controls are IINA's; close its window when done${C.reset}`);
    return;
  }

  const engine = new ExternalMpvEngine({
    headless: args.includes('--headless'),
    // On by default now; --no-hdr forces tone-mapping for an SDR display.
    hdrPassthrough: !args.includes('--no-hdr'),
    maxCacheBytes: cacheArg ? cacheArg.split('=')[1] : undefined,
    quality: qualityArg ? (qualityArg.split('=')[1] as QualityTier) : 'auto',
    audioChannels: channelsArg ? channelsArg.split('=')[1] : undefined,
    ao: aoArg ? aoArg.split('=')[1] : undefined,
    targetPeak: peakArg ? Number(peakArg.split('=')[1]) : undefined,
    gpuContext: ctxArg ? ctxArg.split('=')[1] : undefined,
    nativeMetal: args.includes('--metal'),
    raw: rawArg ? rawArg.slice('--mpv='.length).split(/\s+/).filter(Boolean) : undefined,
    motionInterpolation: args.includes('--motion')
      ? true
      : args.includes('--no-motion')
        ? false
        : undefined,
    adaptiveQuality: !args.includes('--no-adapt'),
    onQualityChange: (tier, reason) => {
      process.stdout.write(`\n${C.yellow}quality → ${QUALITY_TIERS[tier].label}: ${reason}${C.reset}\n`);
    },
    onExit: (code) => {
      if (!shuttingDown) {
        process.stdout.write(`\n${C.red}mpv exited unexpectedly (code ${code})${C.reset}\n`);
        process.exit(1);
      }
    },
  });

  let shuttingDown = false;

  const t0 = Date.now();
  await engine.start();
  const startupMs = Date.now() - t0;

  const t1 = Date.now();
  await engine.load(file, { startAt });
  const loadMs = Date.now() - t1;

  // Everything below is read once the file is open.
  /**
   * Read a property, tolerating "property unavailable".
   *
   * mpv fires `file-loaded` before the video and audio params are populated, so a
   * read here is a race. With `vo=null` they resolve instantly and the race never
   * shows; with a real video output it reliably kills the process. Retry briefly,
   * then give up quietly — a diagnostic must never be the thing that crashes.
   */
  const read = async <K extends Parameters<typeof engine.get>[0]>(
    prop: K,
    tries = 6,
  ): Promise<Awaited<ReturnType<typeof engine.get>> | null> => {
    for (let i = 0; i < tries; i++) {
      try {
        const value = await engine.get(prop);
        if (value !== null && value !== undefined) return value;
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  };

  const [duration, tracks, hwdec, vfmt, acodec, w, h] = await Promise.all([
    read('duration'),
    read('track-list'),
    read('hwdec-current'),
    read('video-format'),
    read('audio-codec-name'),
    read('width'),
    read('height'),
  ]);

  const trackList = (tracks as MpvTrack[] | null) ?? [];
  const audioTracks = trackList.filter((t) => t.type === 'audio');

  // The audio device opens a beat after the file does.
  const [ao, inCh, outCh, outLayout, device] = await Promise.all([
    read('current-ao'),
    read('audio-params/channel-count'),
    read('audio-out-params/channel-count'),
    read('audio-out-params/hr-channels'),
    read('audio-device'),
  ]);
  const subTracks = trackList.filter((t) => t.type === 'sub');

  console.log(`\n${C.bold}${file.split('/').pop()}${C.reset}`);
  const slowStart = startupMs > 2000;
  console.log(
    `${C.dim}mpv startup ${slowStart ? C.yellow : ''}${startupMs}ms${C.reset}` +
      `${C.dim} · file open ${loadMs}ms${C.reset}` +
      (slowStart ? ` ${C.dim}(first run compiles shaders; re-run to see the cached time)${C.reset}` : ''),
  );
  console.log(`  ${C.dim}${fmtTime(duration as number | null)}${C.reset}`);

  /**
   * Read back what is ACTUALLY happening rather than reprinting the config.
   *
   * Every setting is a request mpv may decline — hardware decode can fall back, an HDR
   * hint can be ignored, a 7.1 track can be downmixed by the device. Printing the
   * request is how HDR stayed off for weeks without anyone noticing.
   */
  const status = await readPlaybackStatus(engine);
  for (const line of formatStatus(status)) console.log(line);
  if (engine.metalUnavailable) {
    console.log(
      `  ${C.yellow}⚠ this mpv has no cocoa-cb context${C.reset} ` +
        `${C.dim}— native Metal unavailable, using the default path${C.reset}`,
    );
  }
  const videoFlags = engine.videoFlags;
  if (videoFlags.length) console.log(`  ${C.dim}video: ${videoFlags.join(' ')}${C.reset}`);
  console.log(`  ${C.dim}${audioTracks.length} audio · ${subTracks.length} subtitle tracks${C.reset}`);

  const caps = engine.machineCapabilities;
  const tierDef = QUALITY_TIERS[engine.qualityTier];
  if (caps) {
    console.log(
      `  ${C.cyan}quality: ${tierDef.label}${C.reset}` +
        `${engine.motionInterpolation ? ` ${C.cyan}+ motion${C.reset}` : ''} ${C.dim}(${caps.chip}` +
        `${caps.gpuCores ? `, ${caps.gpuCores} GPU cores` : ''}, ${caps.memoryGB} GB)${C.reset}`,
    );
  } else {
    console.log(`  ${C.cyan}quality: ${tierDef.label}${C.reset}`);
  }
  console.log(`\n${C.dim}space play/pause · ←/→ ∓10s · ↑/↓ ∓60s · m mute · q quit${C.reset}\n`);

  let pos = 0;
  let paused = false;
  let cacheSecs: number | null = null;
  let drops = 0;
  let dropWindow: Array<{ t: number; n: number }> = [];

  engine.observe('time-pos', (v) => { if (v !== null) pos = v; });
  engine.observe('pause', (v) => { paused = v; });
  engine.observe('demuxer-cache-duration', (v) => { cacheSecs = v; });
  engine.observe('frame-drop-count', (v) => {
    drops = Number(v ?? 0);
    const now = Date.now();
    dropWindow.push({ t: now, n: drops });
    dropWindow = dropWindow.filter((d) => now - d.t < 10_000);
  });

  const render = () => {
    const icon = paused ? '❚❚' : '▶ ';
    const cache = cacheSecs !== null ? ` ${C.dim}buf ${cacheSecs.toFixed(0)}s${C.reset}` : '';
    // A cumulative count says nothing about whether playback is healthy NOW.
    // Rate over a trailing window is what actually matters.
    let dropped = '';
    if (drops > 0) {
      const w = dropWindow;
      const rate = w.length > 1 ? (w[w.length - 1].n - w[0].n) / ((w[w.length - 1].t - w[0].t) / 1000) : 0;
      // Judge by share of frames, not raw rate: 0.34/s sounds bad but is 1.4% at
      // 24fps, and 3 drops across a minute is nothing. Colour on the sustained
      // figure so a brief seek burst does not look like a problem.
      const pct = (rate / 24) * 100;
      const colour = pct > 1 ? C.red : pct > 0.3 ? C.yellow : C.dim;
      dropped = ` ${colour}drops ${drops} (${pct.toFixed(1)}% now)${C.reset}`;
    }
    process.stdout.write(
      `\r  ${icon} ${bar(pos, (duration as number | null) ?? 0)} ${C.cyan}${fmtTime(pos)}${C.reset}` +
        `${C.dim}/${fmtTime(duration as number | null)}${C.reset}${cache}${dropped}\x1b[K`,
    );
  };
  const timer = setInterval(render, 250);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\n');
    await engine.dispose();
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key: string) => {
      switch (key) {
        case ' ': void engine.togglePause(); break;
        case '\u001b[C': engine.seek(10, 'relative'); break;   // right
        case '\u001b[D': engine.seek(-10, 'relative'); break;  // left
        case '\u001b[A': engine.seek(60, 'relative'); break;   // up
        case '\u001b[B': engine.seek(-60, 'relative'); break;  // down
        case 'm': void engine.get('mute').then((m) => engine.setMute(!m)); break;
        case 'q':
        case '\u0003': void shutdown(); break;
      }
    });
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(`\n${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}`);
  process.exit(1);
});
