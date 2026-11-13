import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  countInFlightRecipientPaneLocks,
  getPendingLongRecipientPaneLockWaits,
  PaneLockTakenOverError,
  REAL_RECIPIENT_PANE_LOCK_DEPS,
  RecipientPaneLockService,
  type RecipientPaneLockDeps,
} from './recipient-pane-lock.service.ts';
import { lockTestProcesses, type ChildRun } from './lock-rows/lock-test-support.ts';

const PANE_ID = 'w1:p-lock-minute';
const serviceModule = path.join(import.meta.dirname, 'recipient-pane-lock.service.ts');
const { scratchThroneHome, runChild } = lockTestProcesses('pane-lock-');

interface Clock {
  nowMs: number;
}

function depsFor(clock: Clock, sleep: (milliseconds: number) => Promise<void>): RecipientPaneLockDeps {
  return { ...REAL_RECIPIENT_PANE_LOCK_DEPS, now: () => clock.nowMs, sleep };
}

function advancingSleep(clock: Clock): (milliseconds: number) => Promise<void> {
  return async (milliseconds) => {
    clock.nowMs += milliseconds;
    await new Promise((resolve) => setImmediate(resolve));
  };
}

const realTimeSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const neverEndingSleep = () => new Promise<void>(() => {});

async function holdPaneLock(clock: Clock, throneHome: string, service = new RecipientPaneLockService()) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });
  const holding = service.withRecipientPaneLock(PANE_ID, async () => {
    signalHeld();
    await finished;
  }, { throneHome }, depsFor(clock, neverEndingSleep));
  await held;
  return { finish, holding };
}

function sendHoldingTheLock(
  clock: Clock,
  throneHome: string,
  sleep: (milliseconds: number) => Promise<void>,
  takeOver: (paneId: string) => Promise<void>,
) {
  return new RecipientPaneLockService().withRecipientPaneLock(
    PANE_ID,
    async () => clock.nowMs,
    { throneHome, takeOver },
    depsFor(clock, sleep),
  );
}

async function quietPaneLockAgedBy(context: TestContext, ageMs: number) {
  context.mock.method(console, 'warn', () => {});
  const throneHome = await scratchThroneHome();
  const clock = { nowMs: 1_000_000 };
  const holder = await holdPaneLock(clock, throneHome);
  clock.nowMs += ageMs;
  return { throneHome, clock, holder };
}

function runSender(script: string): ChildRun {
  return runChild(`
    const { RecipientPaneLockService } = await import(${JSON.stringify(serviceModule)});
    const service = new RecipientPaneLockService();
    ${script}
  `);
}

test('two senders in separate processes type into one pane one at a time', async () => {
  const throneHome = await scratchThroneHome();
  const pane = path.join(throneHome, 'pane');
  const sender = () => runSender(`
    const { appendFileSync } = await import('node:fs');
    for (let round = 0; round < 5; round += 1) {
      await service.withRecipientPaneLock(${JSON.stringify(PANE_ID)}, async () => {
        appendFileSync(${JSON.stringify(pane)}, 'start typing\\n');
        await new Promise((resolve) => setTimeout(resolve, 30));
        appendFileSync(${JSON.stringify(pane)}, 'press Enter\\n');
      }, { throneHome: ${JSON.stringify(throneHome)} });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  `);
  const senders = [sender(), sender()];

  assert.deepEqual(await Promise.all(senders.map((each) => each.exited)), [0, 0]);
  const typed = (await readFile(pane, 'utf8')).trim().split('\n');
  assert.equal(typed.length, 20);
  typed.forEach((line, index) => assert.equal(line, index % 2 === 0 ? 'start typing' : 'press Enter'));
});

test('a sender killed with SIGKILL frees the pane for the next sender', async () => {
  const throneHome = await scratchThroneHome();
  const killed = runSender(`
    await service.withRecipientPaneLock(${JSON.stringify(PANE_ID)}, async () => {
      console.log('holding');
      await new Promise(() => {});
    }, { throneHome: ${JSON.stringify(throneHome)} });
  `);
  assert.equal(await killed.firstLine, 'holding');
  const service = new RecipientPaneLockService();
  assert.equal(await service.isHeldByAnotherSender(PANE_ID, { throneHome }), true);
  assert.equal(await countInFlightRecipientPaneLocks({ throneHome }), 1);

  killed.child.kill('SIGKILL');
  await killed.exited;

  const delivered = await service.withRecipientPaneLock(PANE_ID, async () => 'delivered', { throneHome }, {
    ...REAL_RECIPIENT_PANE_LOCK_DEPS,
    sleep: neverEndingSleep,
  });
  assert.equal(delivered, 'delivered');
  assert.equal(await countInFlightRecipientPaneLocks({ throneHome }), 0);
});

test('a sender that finds a pane lock younger than a minute waits until it is a minute old', async (context: TestContext) => {
  const { throneHome, clock, holder } = await quietPaneLockAgedBy(context, 20_000);
  const takeOvers: number[] = [];

  const deliveredAtMs = await sendHoldingTheLock(clock, throneHome, advancingSleep(clock), async () => {
    takeOvers.push(clock.nowMs);
  });

  assert.deepEqual(takeOvers, [1_060_000]);
  assert.equal(deliveredAtMs, 1_060_000);
  holder.finish();
  await holder.holding;
});

test('a sender that finds a pane lock released before a minute delivers at once', async () => {
  const throneHome = await scratchThroneHome();
  const clock = { nowMs: 1_000_000 };
  const holder = await holdPaneLock(clock, throneHome);
  clock.nowMs += 20_000;
  let takeOvers = 0;

  const sending = sendHoldingTheLock(clock, throneHome, realTimeSleep, async () => { takeOvers += 1; });
  holder.finish();
  await holder.holding;

  assert.equal(await sending, 1_020_000);
  assert.equal(takeOvers, 0);
});

test('a pane lock older than 60 s is taken over and the takeover callback runs', async (context: TestContext) => {
  const warnings = context.mock.method(console, 'warn', () => {});
  const throneHome = await scratchThroneHome();
  const clock = { nowMs: 1_000_000 };
  const holder = await holdPaneLock(clock, throneHome);
  clock.nowMs += 75_000;
  const takenOverPanes: string[] = [];

  await sendHoldingTheLock(clock, throneHome, neverEndingSleep, async (paneId) => { takenOverPanes.push(paneId); });

  assert.deepEqual(takenOverPanes, [PANE_ID]);
  const lines = warnings.mock.calls.map((call) => String(call.arguments[0]));
  assert.deepEqual(lines, [`recipient pane lock for ${PANE_ID} taken over from process ${process.pid} after 75000ms`]);
  holder.finish();
  await holder.holding;
});

test('a takeover still happens when the forced Enter refuses because of a dialog', async (context: TestContext) => {
  const { throneHome, clock, holder } = await quietPaneLockAgedBy(context, 60_000);

  const deliveredAtMs = await sendHoldingTheLock(clock, throneHome, neverEndingSleep, async () => {
    throw new Error('a dialog covers the composer');
  });

  assert.equal(deliveredAtMs, 1_060_000);
  holder.finish();
  await holder.holding;
});

test('a sender whose lock was taken over learns it before typing again', async (context: TestContext) => {
  context.mock.method(console, 'warn', () => {});
  const throneHome = await scratchThroneHome();
  const clock = { nowMs: 1_000_000 };
  const holderService = new RecipientPaneLockService();
  const writes: string[] = [];
  let takeoverDone!: () => void;
  const takeoverLanded = new Promise<void>((resolve) => { takeoverDone = resolve; });
  let signalWritten!: () => void;
  const written = new Promise<void>((resolve) => { signalWritten = resolve; });

  const holding = holderService.withRecipientPaneLock(PANE_ID, async () => {
    await holderService.confirmStillOwnsPaneLock(PANE_ID);
    writes.push('old text');
    signalWritten();
    await takeoverLanded;
    await holderService.confirmStillOwnsPaneLock(PANE_ID);
    writes.push('Enter');
  }, { throneHome }, depsFor(clock, neverEndingSleep));
  await written;
  clock.nowMs += 60_000;
  await sendHoldingTheLock(clock, throneHome, neverEndingSleep, async () => {});
  takeoverDone();

  await assert.rejects(holding, PaneLockTakenOverError);
  assert.deepEqual(writes, ['old text']);
});

test('a holder that was taken over does not free the pane from its taker', async (context: TestContext) => {
  const { throneHome, clock, holder } = await quietPaneLockAgedBy(context, 61_000);
  const takerService = new RecipientPaneLockService();
  let finishTaker!: () => void;
  const takerFinished = new Promise<void>((resolve) => { finishTaker = resolve; });
  let signalTaken!: () => void;
  const taken = new Promise<void>((resolve) => { signalTaken = resolve; });
  const taking = takerService.withRecipientPaneLock(PANE_ID, async () => {
    signalTaken();
    await takerFinished;
    await takerService.confirmStillOwnsPaneLock(PANE_ID);
  }, { throneHome, takeOver: async () => {} }, depsFor(clock, neverEndingSleep));
  await taken;
  holder.finish();
  await holder.holding;

  assert.equal(await new RecipientPaneLockService().isHeldByAnotherSender(PANE_ID, { throneHome }), true);
  finishTaker();
  await taking;
});

test('re-entry in the same task does not deadlock', async () => {
  const throneHome = await scratchThroneHome();
  const service = new RecipientPaneLockService();
  const deps = { ...REAL_RECIPIENT_PANE_LOCK_DEPS, sleep: neverEndingSleep };

  const inner = await service.withRecipientPaneLock(PANE_ID, () =>
    service.withRecipientPaneLock(PANE_ID, async () => 'inner delivered', { throneHome }, deps), { throneHome }, deps);

  assert.equal(inner, 'inner delivered');
});

test('a long wait is reported while it lasts', async (context: TestContext) => {
  context.mock.method(console, 'warn', () => {});
  const throneHome = await scratchThroneHome();
  const clock = { nowMs: Date.now() };
  const holder = await holdPaneLock(clock, throneHome);
  const sending = new RecipientPaneLockService().withRecipientPaneLock(PANE_ID, async () => {}, {
    throneHome,
    longWaitThresholdMs: 20,
  }, depsFor(clock, realTimeSleep));
  await realTimeSleep(100);

  assert.deepEqual(getPendingLongRecipientPaneLockWaits().map((wait) => wait.paneId), [PANE_ID]);
  holder.finish();
  await holder.holding;
  await sending;
  assert.deepEqual(getPendingLongRecipientPaneLockWaits(), []);
});
