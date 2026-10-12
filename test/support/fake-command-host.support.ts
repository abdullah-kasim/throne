import { access, constants, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function findOnPath(name: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`required command "${name}" not found on this machine's PATH`);
}

export async function writeFakeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

export async function linkRealCommands(fakeBin: string, names: string[]): Promise<void> {
  for (const name of names) {
    await symlink(await findOnPath(name), path.join(fakeBin, name));
  }
}
