import { registerHooks } from 'node:module';
import path from 'node:path';
import {
  pinTheBudgetFileSystemAs,
  type PinnedContender,
} from './jev-budget-pinned-file-system.test-support.ts';

const PINNED_FILE_SYSTEM_URL = new URL('./jev-budget-pinned-file-system.test-support.ts', import.meta.url).href;
const FILES_WHOSE_FILE_SYSTEM_IS_PINNED = ['/atomic-mkdir-lock.ts', '/jev-budget.ts'];
export const LATE_CONTENDER_SAW_THE_STALE_LOCK_FILE_NAME = 'late contender saw the stale lock';

export interface PinnedSpendingOrder {
  readonly dataHome: string;
  readonly goFile: string;
  readonly tokensPerDay: number;
  readonly requests: number;
  readonly contender: PinnedContender;
}

function redirectTheBudgetFileSystemToThePinnedOne(): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === 'node:fs/promises' &&
      FILES_WHOSE_FILE_SYSTEM_IS_PINNED.some((fileName) => context.parentURL?.endsWith(fileName))
        ? { url: PINNED_FILE_SYSTEM_URL, shortCircuit: true }
        : nextResolve(specifier, context),
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
