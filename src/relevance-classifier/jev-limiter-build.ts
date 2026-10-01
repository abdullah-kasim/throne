import { stat } from 'node:fs/promises';
import path from 'node:path';

export const JEV_LIMITER_VERSION = 1;
const BUILD_OUTPUT_DIRECTORY_NAME = 'dist';
const GIT_ENTRY_NAME = '.git';

export interface JevLimiterBuild {
  readonly limiterVersion: number;
  readonly runsFromTheLiveCheckout: boolean;
}

function isFileSystemRoot(directory: string): boolean {
  return path.dirname(directory) === directory;
}

async function gitEntryIn(directory: string): Promise<'directory' | 'file' | undefined> {
  try {
    return (await stat(path.join(directory, GIT_ENTRY_NAME))).isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function mainCheckoutContaining(filePath: string): Promise<string | undefined> {
  for (let directory = path.dirname(filePath); ; directory = path.dirname(directory)) {
    const gitEntry = await gitEntryIn(directory);
    if (gitEntry !== undefined) return gitEntry === 'directory' ? directory : undefined;
    if (isFileSystemRoot(directory)) return undefined;
  }
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

export async function isInsideTheLiveCheckoutBuild(modulePath: string): Promise<boolean> {
  const mainCheckout = await mainCheckoutContaining(modulePath);
  return (
    mainCheckout !== undefined &&
    isInsideDirectory(modulePath, path.join(mainCheckout, BUILD_OUTPUT_DIRECTORY_NAME))
  );
}
