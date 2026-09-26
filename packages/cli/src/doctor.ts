#!/usr/bin/env tsx
/**
 * pnpm doctor — verify native dependencies.
 *
 * The app depends on binaries pnpm cannot install. Fail loudly and with the exact
 * remedy rather than letting a scan die three minutes in.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type Check = {
  name: string;
  probe: () => Promise<string>;
  remedy: string;
  required: boolean;
};

const checks: Check[] = [
  {
    name: 'ffprobe',
    required: true,
    remedy: 'brew install ffmpeg',
    probe: async () => {
      const { stdout } = await exec('ffprobe', ['-version']);
      return stdout.split('\n')[0];
    },
  },
  {
    name: 'mpv',
    required: true,
    remedy: 'brew install mpv',
    probe: async () => {
      const { stdout } = await exec('mpv', ['--version']);
      const line = stdout.split('\n')[0];

      /**
       * Flag an mpv too old for macOS HDR.
       *
       * EDR handling on macOS improved substantially after 0.37 (Nov 2023). On older
       * builds `--target-colorspace-hint` negotiates poorly and HDR ends up DIMMER
       * than a tone-mapped SDR image, which looks like the feature is broken rather
       * than the version being stale.
       */
      const m = line.match(/mpv (\d+)\.(\d+)/);
      if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        if (major === 0 && minor < 38) {
          return `${line}  ⚠ older than 0.38 — HDR on macOS is weak here; brew upgrade mpv`;
        }
      }
      return line;
    },
  },
  {
    name: 'IINA',
    required: false,
    remedy: 'brew install --cask iina   (preferred player: better HDR on Apple silicon)',
    probe: async () => {
      const { findIinaCli } = await import('@nfl/player');
      const cli = await findIinaCli();
      if (!cli) throw new Error('not installed');

      /**
       * Having IINA is not enough — it must also expose an IPC socket, which can only
       * be set in IINA's own preferences. Without it films play but watch progress
       * cannot be tracked, so say so here rather than at the moment someone loses it.
       */
      const { DEFAULT_IINA_SOCKET } = await import('@nfl/player');
      return (
        `${cli}\n     in IINA → Settings → Advanced → Additional mpv options, add the option ` +
        `input-ipc-server with the value ${DEFAULT_IINA_SOCKET}`
      );
    },
  },
  {
    name: 'yt-dlp',
    required: false,
    remedy: 'brew install yt-dlp   (needed only for trailer caching)',
    probe: async () => {
      const { stdout } = await exec('yt-dlp', ['--version']);
      return `yt-dlp ${stdout.trim()}`;
    },
  },
];

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const X = '\x1b[0m';

async function main() {
  let hardFail = false;
  console.log('');

  for (const check of checks) {
    try {
      const version = await check.probe();
      console.log(`  ${G}✓${X} ${check.name.padEnd(10)} ${D}${version}${X}`);
    } catch {
      if (check.required) {
        hardFail = true;
        console.log(`  ${R}✗${X} ${check.name.padEnd(10)} ${R}missing${X}  → ${check.remedy}`);
      } else {
        console.log(`  ${Y}−${X} ${check.name.padEnd(10)} ${Y}optional, missing${X}  → ${check.remedy}`);
      }
    }
  }

  // The Electron runtime is a separate ~280MB download from the npm package, and
  // pnpm can silently skip fetching it. Check the artefact, not the package.
  try {
    const { existsSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const req = createRequire(import.meta.url);
    const dir = dirname(req.resolve('electron/package.json'));
    if (existsSync(join(dir, 'path.txt')) && existsSync(join(dir, 'dist'))) {
      console.log(`  ${G}✓${X} electron   ${D}runtime present${X}`);
    } else {
      console.log(
        `  ${Y}−${X} electron   ${Y}runtime not downloaded${X}  → pnpm app:fix   ${D}(CLI tools still work)${X}`,
      );
    }
  } catch {
    console.log(`  ${Y}−${X} electron   ${Y}not installed${X}  → pnpm install`);
  }

  if (process.arch !== 'arm64' || process.platform !== 'darwin') {
    console.log(
      `  ${Y}−${X} platform   ${Y}${process.platform}/${process.arch}${X} ${D}(target is darwin/arm64)${X}`,
    );
  } else {
    console.log(`  ${G}✓${X} platform   ${D}darwin/arm64${X}`);
  }

  // Surface the learned quality ceiling — otherwise a machine capped by an old
  // measurement looks like it is simply choosing a lower tier for no reason.
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    // Same place the player writes it — inside the project's data directory.
    const { dataPaths: resolvePaths } = await import('@nfl/core');
    const capsPath = join(resolvePaths().cacheDir, 'capabilities.json');
    const caps = JSON.parse(await readFile(capsPath, 'utf8'));
    const line = [
      caps.chip,
      caps.gpuCores ? `${caps.gpuCores} GPU cores` : null,
      `suggests ${caps.suggestedTier}`,
      caps.observedCeiling ? `has fallen back to ${caps.observedCeiling} before` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`  ${G}✓${X} quality   ${D}${line}${X}`);
    if (caps.observedCeiling && caps.observedCeiling !== caps.suggestedTier) {
      console.log(
        `     ${D}playback still STARTS at ${caps.suggestedTier}; this only records a` +
          ` previous fallback${X}`,
      );
    }
  } catch {
    /* not probed yet */
  }

  const { dataPaths } = await import('@nfl/core');
  const paths = dataPaths();
  const { findProjectRoot } = await import('@nfl/core');
  const projectDir = findProjectRoot(process.cwd()) ?? process.cwd();
  console.log('');
  console.log(`  ${D}library data: ${paths.root}${X}`);
  // Say what is true. This line used to claim the data sat outside the repo, printed
  // directly under a path inside it — which is exactly backwards, and the reassurance
  // was the dangerous part: replacing the project folder DOES erase it.
  const inRepo = paths.root.startsWith(projectDir);
  console.log(
    inRepo
      ? `  ${D}(gitignored, and inside the project — copy it across if you replace the folder,${X}\n` +
        `  ${D} or set NFL_DATA_DIR somewhere outside)${X}`
      : `  ${D}(outside the project, so replacing the folder cannot erase it)${X}`,
  );

  console.log('');
  if (hardFail) {
    console.log(`${R}Missing required dependencies.${X} Install them and re-run pnpm doctor.\n`);
    process.exit(1);
  }
  console.log(`${G}All required dependencies present.${X}\n`);
}

main();
