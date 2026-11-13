import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  pinTheBudgetFileSystemAs,
  type PinnedContender,
} from './jev-budget-pinned-file-system.test-support.ts';

const PINNED_FILE_SYSTEM_URL = new URL('./jev-budget-pinned-file-system.test-support.ts', import.meta.url).href;
const FILES_WHOSE_FILE_SYSTEM_IS_PINNED = /\/(atomic-mkdir-lock|jev-budget)\.ts$/;
const FILE_SYSTEM_IMPORT = /(['"])node:fs\/promises\1/g;
export const LATE_CONTENDER_SAW_THE_STALE_LOCK_FILE_NAME = 'late contender saw the stale lock';

export interface PinnedSpendingOrder {
  readonly dataHome: string;
  readonly goFile: string;
  readonly tokensPerDay: number;
  readonly requests: number;
  readonly contender: PinnedContender;
}

interface SourceLoaderPlugin {
  setup(build: {
    onLoad(
      options: { readonly filter: RegExp },
      load: (file: { readonly path: string }) => Promise<{ readonly contents: string; readonly loader: 'ts' }>,
    ): void;
  }): void;
}

const bunRuntime = (globalThis as unknown as { readonly Bun: { plugin(plugin: SourceLoaderPlugin): void } }).Bun;

function redirectTheBudgetFileSystemToThePinnedOne(): void {
  bunRuntime.plugin({
    setup(build) {
      build.onLoad({ filter: FILES_WHOSE_FILE_SYSTEM_IS_PINNED }, async (args) => ({
        contents: (await readFile(args.path, 'utf8')).replace(FILE_SYSTEM_IMPORT, JSON.stringify(PINNED_FILE_SYSTEM_URL)),
        loader: 'ts',
      }));
    },
  });
}

if (process.argv[1] === import.meta.filename) {
  const order = JSON.parse(process.argv[2]!) as PinnedSpendingOrder;
  redirectTheBudgetFileSystemToThePinnedOne();
  const { jevBudgetLockPath, jevBudgetTallyPath } = await import('./jev-budget.ts');
  pinTheBudgetFileSystemAs(order.contender, {
    lockPath: jevBudgetLockPath(order.dataHome),
    tallyPath: jevBudgetTallyPath(order.dataHome),
    lateContenderSawTheStaleLock: path.join(order.dataHome, LATE_CONTENDER_SAW_THE_STALE_LOCK_FILE_NAME),
  });
  const { spendThroughJevOnGo } = await import('./jev-budget-processes.test-support.ts');
  await spendThroughJevOnGo(order);
}
