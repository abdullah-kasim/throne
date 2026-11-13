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

function realUserId(): number {
  return process.getuid?.() ?? -1;
}

export const REAL_DEPS: InstallServicesDeps = {
  ...REAL_SERVICE_UNIT_DEPS,
  platform: process.platform,
  arch: process.arch,
  ownedHerdrPath: ownedHerdrExecutablePath,
  herdrCacheDirectory: ownedHerdrCacheDirectory,
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
