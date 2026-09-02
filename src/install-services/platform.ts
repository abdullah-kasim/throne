import { existsSync } from 'node:fs';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REAL_FEATURE_FLAGS_SERVICE } from '../shared-policy/feature-flags.service.ts';
import {
  installPinnedHerdr,
  ownedHerdrCacheDirectory,
  ownedHerdrExecutablePath,
} from './herdr-release.service.ts';
import {
  REAL_SERVICE_UNIT_DEPS,
  runLaunchctl,
} from '../install-services/service-unit-renderer.service.ts';
import type { InstallServicesDeps } from './install-services.types.ts';

function realUserId(): number {
  return process.getuid?.() ?? -1;
}

/**
 * The mise `lts` node symlink path under the user's home directory — the
 * same `os.homedir()`-relative form ownedHerdrPath()/herdrCacheDirectory()
 * already use for other machine-local paths, never an environment-variable
 * lookup. Returns null (never a bare "node" fallback) when the symlink
 * doesn't resolve, so a missing mise install fails loudly at render time
 * instead of silently reintroducing the PATH bug this exists to fix.
 */
function realResolveNodeBin(): string | null {
  const nodeBin = path.join(
    os.homedir(),
    '.local',
    'share',
    'mise',
    'installs',
    'node',
    'lts',
    'bin',
    'node',
  );
  return existsSync(nodeBin) ? nodeBin : null;
}

export const REAL_DEPS: InstallServicesDeps = {
  ...REAL_SERVICE_UNIT_DEPS,
  platform: process.platform,
  arch: process.arch,
  ownedHerdrPath: ownedHerdrExecutablePath,
  herdrCacheDirectory: ownedHerdrCacheDirectory,
  resolveNodeBin: realResolveNodeBin,
  installHerdr: installPinnedHerdr,
  launchctl: runLaunchctl,
  userId: realUserId,
  throneCommandPath: () => path.join(os.homedir(), '.local', 'bin', 'throne'),
  inspectThroneCommand: async (targetPath) => {
    try {
      const entry = await lstat(targetPath);
      return entry.isSymbolicLink()
        ? { kind: 'symlink', target: await readlink(targetPath) }
        : { kind: 'file' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing' };
      }
      throw error;
    }
  },
  createThroneCommandSymlink: async (sourcePath, targetPath) => {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink(sourcePath, targetPath);
  },
  herdrDecoupleEnabled: () => REAL_FEATURE_FLAGS_SERVICE.enabled('herdr-decouple'),
  pathSymlinkTargets: () => [
    path.join(os.homedir(), 'bin', 'throne'),
    path.join(os.homedir(), 'bin', 'throne-cli'),
    path.join(os.homedir(), '.local', 'bin', 'throne'),
    path.join(os.homedir(), '.local', 'bin', 'throne-cli'),
  ],
  inspectPathSymlink: async (targetPath) => {
    try {
      const entry = await lstat(targetPath);
      return entry.isSymbolicLink()
        ? { kind: 'symlink', target: await readlink(targetPath) }
        : { kind: 'file' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing' };
      }
      throw error;
    }
  },
  writePathSymlink: async (sourcePath, targetPath) => {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await rm(targetPath, { force: true });
    await symlink(sourcePath, targetPath);
  },
  removeUnitFile: async (targetPath) => {
    await rm(targetPath, { force: true });
  },
};
