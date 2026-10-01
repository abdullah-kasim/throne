import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireAtomicMkdirLock } from '../alpha-monitoring/atomic-mkdir-lock.ts';
import { jevBudgetDirectory, jevBudgetLockPath } from './jev-budget.ts';

export const LOCK_HELD_SIGNAL = 'jev budget lock held\n';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface ProcessHoldingTheJevBudgetLock {
  readonly child: ChildProcess;
  readonly heldAt: number;
}

async function holdTheJevBudgetLockUntilKilled(dataHome: string): Promise<void> {
  await mkdir(jevBudgetDirectory(dataHome), { recursive: true });
  await acquireAtomicMkdirLock({ lockPath: jevBudgetLockPath(dataHome), holder: `killed holder ${process.pid}` });
  process.stdout.write(LOCK_HELD_SIGNAL);
  setInterval(() => undefined, 60_000);
}

export async function startProcessHoldingTheJevBudgetLock(dataHome: string): Promise<ProcessHoldingTheJevBudgetLock> {
  const child = spawn(
    process.execPath,
    ['--import', './test/register-typescript.mjs', import.meta.filename, dataHome],
    { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes(LOCK_HELD_SIGNAL)) resolve();
    });
    child.once('exit', (code) => reject(new Error(`lock holder exited early with code ${code}`)));
  });
  return { child, heldAt: Date.now() };
}

export async function killWithoutCleanup(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

if (process.argv[1] === import.meta.filename) {
  await holdTheJevBudgetLockUntilKilled(process.argv[2]!);
}
