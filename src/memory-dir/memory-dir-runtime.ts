// The real effects behind the memory-dir resolver: git, the filesystem, PATH
// lookup, and the operator's own tool when one exists. Tests never touch
// this file; they pass fakes at the `MemoryResolverDeps` seam.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { delimiter } from 'node:path';
import type { MemoryResolverDeps } from './memory-dir-resolver.ts';

const execFileAsync = promisify(execFile);

async function run(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(executable, args, { cwd, encoding: 'utf8' });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export const PRODUCTION_MEMORY_RESOLVER_DEPS: MemoryResolverDeps = {
  async gitCommonDir(dir) {
    const result = await run('git', ['rev-parse', '--git-common-dir'], dir);
    return result.ok ? result.stdout.trim() : undefined;
  },
  pathExists: exists,
  async readText(file) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  async findExecutable(name) {
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (entry === '') continue;
      const candidate = path.join(entry, name);
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  },
  async runExecutable(executable, args, cwd) {
    const result = await run(executable, args, cwd);
    if (!result.ok) throw new Error(`${executable} ${args.join(' ')} failed`);
    return result.stdout;
  },
  realpath: (candidate) => realpath(candidate),
  homeDir: () => homedir(),
};
