#!/usr/bin/env tsx
/**
 * pnpm volumes list                     probe every paired root
 * pnpm volumes add <path> [--label=X]   pair a library root
 * pnpm volumes remove <id>
 * pnpm volumes watch                    live mount/unmount events
 */

import { VolumeManager, inspectVolume } from '@nfl/core';
import { C, VOLUMES_FILE , ensureMigrated } from './paths.js';

function statusBadge(status: string): string {
  if (status === 'online') return `${C.green}● online${C.reset}`;
  if (status === 'relocated') return `${C.yellow}● moved${C.reset}`;
  return `${C.red}○ offline${C.reset}`;
}

async function list(vm: VolumeManager) {
  const roots = await vm.load();
  if (roots.length === 0) {
    console.log(`\n${C.dim}No library roots paired yet.${C.reset}`);
    console.log(`  pnpm volumes add /Volumes/YourDrive/Movies --label="Movies SSD"\n`);
    return;
  }

  const states = await vm.probeAll();
  console.log('');
  for (const s of states) {
    console.log(`  ${statusBadge(s.status)}  ${C.bold}${s.root.label}${C.reset} ${C.dim}${s.root.id}${C.reset}`);
    console.log(`     ${C.dim}${s.root.path}${C.reset}`);

    if (s.status === 'relocated' && s.resolvedPath) {
      // The whole point of storing a UUID: the drive moved and we still found it.
      console.log(`     ${C.yellow}now at ${s.resolvedPath}${C.reset} ${C.dim}(found by volume UUID)${C.reset}`);
      await vm.commitRelocation(s.root.id, s.resolvedPath);
      console.log(`     ${C.dim}path updated${C.reset}`);
    }

    const meta = [
      s.root.kind,
      s.root.fileSystem,
      s.root.volumeUUID ? `uuid ${s.root.volumeUUID.slice(0, 8)}…` : `${C.yellow}no uuid${C.reset}`,
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`     ${C.dim}${meta} · probed in ${s.probeMs}ms${C.reset}`);
    console.log('');
  }
}

async function main() {
  await ensureMigrated();
  const [cmd, ...rest] = process.argv.slice(2);
  const vm = new VolumeManager(VOLUMES_FILE);

  switch (cmd) {
    case undefined:
    case 'list':
      await list(vm);
      break;

    case 'add': {
      const path = rest.find((a) => !a.startsWith('--'));
      if (!path) {
        console.error(
          'usage: pnpm volumes add <path> [--label="Movies SSD"] [--borrowed]',
        );
        process.exit(1);
      }
      const labelArg = rest.find((a) => a.startsWith('--label='));
      // Someone else's drive: catalogue it, never write to it, and keep it visibly
      // distinct so its titles can be removed wholesale when it goes home.
      const borrowed = rest.includes('--borrowed');
      const info = await inspectVolume(path);
      const root = await vm.pair(path, labelArg?.split('=').slice(1).join('='), { borrowed });

      console.log(`\n  ${C.green}paired${C.reset} ${C.bold}${root.label}${C.reset} ${C.dim}${root.id}${C.reset}`);
      console.log(`     ${C.dim}${root.path}${C.reset}`);
      if (root.borrowed) {
        console.log(
          `     ${C.yellow}borrowed${C.reset} ${C.dim}— nothing will be written to this drive${C.reset}`,
        );
      } else if (root.readOnly) {
        console.log(
          `     ${C.yellow}read-only${C.reset} ${C.dim}— metadata stays local; files are recognised by content${C.reset}`,
        );
      }
      if (root.volumeUUID) {
        console.log(`     ${C.green}✓ volume UUID recorded${C.reset} ${C.dim}— survives remounts under a different name${C.reset}`);
      } else {
        console.log(`     ${C.yellow}⚠ no volume UUID${C.reset} ${C.dim}— this root can only be found at its exact path${C.reset}`);
      }
      if (info.fileSystem) console.log(`     ${C.dim}${info.fileSystem}${info.readOnly ? ' (read-only)' : ''}${C.reset}`);
      if (info.fileSystem?.toLowerCase().includes('exfat')) {
        console.log(`     ${C.yellow}exFAT has no journaling — always eject before unplugging.${C.reset}`);
      }
      console.log('');
      break;
    }

    case 'remove': {
      const id = rest[0];
      if (!id) {
        console.error('usage: pnpm volumes remove <id>');
        process.exit(1);
      }
      await vm.remove(id);
      console.log(`  ${C.dim}removed ${id}${C.reset}\n`);
      break;
    }

    case 'watch': {
      await vm.load();
      console.log(`\n${C.dim}Watching /Volumes for mount changes. Ctrl-C to stop.${C.reset}\n`);
      await list(vm);
      const stop = vm.watchMounts(() => {
        console.log(`${C.cyan}— mount change detected —${C.reset}`);
        void list(vm);
      });
      process.on('SIGINT', () => {
        stop();
        process.exit(0);
      });
      break;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}`);
  process.exit(1);
});
