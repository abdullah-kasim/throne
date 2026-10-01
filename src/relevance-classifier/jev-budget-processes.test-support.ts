import { spawn, type ChildProcess } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { yesOrNoQuestion } from './classifier.types.ts';
import { createJevBackend, type JevBackendDependencies } from './jev-backend.ts';

export const SPENDING_QUESTION = yesOrNoQuestion('question', 'Is it?', { kind: 'any-phrase', phrases: [] });
export const SPENDING_STATE = 'a task';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const READY_SIGNAL = 'ready\n';
const GO_FILE_POLL_MILLISECONDS = 2;

export const FAKE_JEV_DEPENDENCIES: JevBackendDependencies = {
  readKeyFile: () => Promise.resolve('not-a-real-key'),
  createClient: () =>
    Promise.resolve({
      systemOne: (request) =>
        Promise.resolve({
          answers: Object.fromEntries(
            Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 1 } as const]),
          ),
        }),
    }),
};

export interface SpendingProcessOrder {
  readonly dataHome: string;
  readonly goFile: string;
  readonly tokensPerDay: number;
  readonly requests: number;
}

async function waitForFile(filePath: string): Promise<void> {
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch {
      await sleep(GO_FILE_POLL_MILLISECONDS);
    }
  }
}

export async function spendThroughJevOnGo(order: SpendingProcessOrder): Promise<void> {
  const backend = createJevBackend(
    '/unused/jev-key',
    {
      dataHome: order.dataHome,
      limits: { tokensPerDay: order.tokensPerDay, tokensPerHour: Number.MAX_SAFE_INTEGER },
      caller: 'hand recall',
    },
    FAKE_JEV_DEPENDENCIES,
  );
  process.stdout.write(READY_SIGNAL);
  await waitForFile(order.goFile);
  for (let request = 0; request < order.requests; request += 1) {
    await backend.answer(SPENDING_STATE, [SPENDING_QUESTION]).catch(() => undefined);
  }
}

export function startSpendingProcess(
  order: SpendingProcessOrder,
  script: string = import.meta.filename,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', './test/register-typescript.mjs', script, JSON.stringify(order)],
    { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((resolve, reject) => {
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (chunk.includes(READY_SIGNAL)) resolve(child);
    });
    child.once('exit', (code) => reject(new Error(`spending process exited before it was ready, code ${code}`)));
  });
}

export async function startSpendingProcesses(
  count: number,
  order: SpendingProcessOrder,
): Promise<readonly ChildProcess[]> {
  return Promise.all(Array.from({ length: count }, () => startSpendingProcess(order)));
}

export async function letSpendingProcessesGoAndFinish(
  children: readonly ChildProcess[],
  goFile: string,
): Promise<void> {
  const exits = children.map(
    (child) =>
      new Promise<number | null>((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', (code) => resolve(code));
      }),
  );
  await writeFile(goFile, 'go');
  const codes = await Promise.all(exits);
  if (codes.some((code) => code !== 0)) throw new Error(`a spending process failed: ${codes.join(', ')}`);
}

if (process.argv[1] === import.meta.filename) {
  await spendThroughJevOnGo(JSON.parse(process.argv[2]!) as SpendingProcessOrder);
}
