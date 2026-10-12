import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installPinnedHerdr,
  ownedHerdrCacheDirectory,
  ownedHerdrExecutablePath,
} from './herdr-release.service.ts';
import {
  REAL_SERVICE_UNIT_DEPS,
  runLaunchctl,
} from '../install-services/service-unit-renderer.service.ts';
import { herdrConfigPath } from './herdr-session-config.ts';
import { isForgejoInstalledOnThisHost } from './forgejo-installation.ts';
import type { InstallServicesDeps } from './install-services.types.ts';
import { readPinnedNodeVersion } from './pinned-node-version.ts';

function realUserId(): number {
  return process.getuid?.() ?? -1;
}

/**
 * The mise install path of the exact node version pinned in the throne
 * checkout's mise.toml, under the user's home directory — the same
 * `os.homedir()`-relative form ownedHerdrPath()/herdrCacheDirectory()
 * already use for other machine-local paths, never an environment-variable
 * lookup. Returns null (never a bare "node" fallback and never mise's `lts`
 * link) when mise.toml pins no node or that version is not installed, so a
 * missing install fails loudly at render time instead of silently running
 * an unpinned node.
 */
function realResolveNodeBin(throneRoot: string): string | null {
  const pinnedVersion = readPinnedNodeVersion(throneRoot);
  if (pinnedVersion === null) {
    return null;
  }
  const nodeBin = path.join(
    os.homedir(),
    '.local',
    'share',
    'mise',
    'installs',
    'node',
    pinnedVersion,
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
  claudeSettingsPath: () => path.join(os.homedir(), '.claude', 'settings.json'),
  readClaudeSettings: async (settingsPath) => {
    try {
      return await readFile(settingsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  },
  writeClaudeSettings: async (settingsPath, content) => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, content);
  },
  herdrConfigPath: () => herdrConfigPath(),
  bashrcPath: () => path.join(os.homedir(), '.bashrc'),
  isForgejoInstalled: isForgejoInstalledOnThisHost,
};
