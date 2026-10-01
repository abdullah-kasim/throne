import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PRODUCTION_BACKEND_CHOICE_DEPENDENCIES } from './choose-backend.ts';
import { jevBudgetDirectory } from './jev-budget.ts';
import { jevUsageLogPath } from './jev-usage-log.ts';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface JevPathsOfThisRun {
  readonly budgetDirectory?: string;
  readonly usageLog?: string;
  readonly whyUnknown?: string;
}

export function jevPathsOfThisRun(): JevPathsOfThisRun {
  try {
    const dataHome = PRODUCTION_BACKEND_CHOICE_DEPENDENCIES.jevDataHome;
    return { budgetDirectory: jevBudgetDirectory(dataHome), usageLog: jevUsageLogPath(dataHome) };
  } catch (error) {
    return { whyUnknown: error instanceof Error ? error.message : String(error) };
  }
}

export async function jevPathsOfARunWithEnvironment(environment: NodeJS.ProcessEnv): Promise<JevPathsOfThisRun> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', './test/register-typescript.mjs', import.meta.filename],
    { cwd: REPOSITORY_ROOT, env: environment },
  );
  return JSON.parse(stdout) as JevPathsOfThisRun;
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(JSON.stringify(jevPathsOfThisRun()));
}
