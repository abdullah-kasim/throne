import os from 'node:os';
import path from 'node:path';

export const THRONE_HOME_DIRECTORY_NAME = '.throne';

export function jevDataHomeOfThisMachine(): string {
  return path.join(os.userInfo().homedir, THRONE_HOME_DIRECTORY_NAME);
}
