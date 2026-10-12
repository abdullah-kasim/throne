import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FORGEJO_INSTALLED_MARKER_NAME = 'enabled';

export function forgejoStateDirectory(): string {
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'forgejo');
}

export async function isForgejoInstalledOnThisHost(): Promise<boolean> {
  try {
    await access(path.join(forgejoStateDirectory(), FORGEJO_INSTALLED_MARKER_NAME));
    return true;
  } catch {
    return false;
  }
}
