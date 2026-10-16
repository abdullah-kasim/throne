import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { buildSubmitToAgentDeps } from "../src/herdr/herdr-send-enter-until-empty.ts";
import { sendTextInSession } from "../src/herdr/herdr-client-session-writes.ts";
import type { HerdrProcessBoundary } from "../src/herdr/herdr-client.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import { submitToAgent } from "../src/herdr/herdr-send.service.ts";
import {
  recoverStrandedSpawn,
  STRANDED_SPAWN_RECOVERY_OUTCOMES,
  type StrandedSpawnRecoveryDeps,
} from "../src/no-idling/stranded-spawn-recovery.ts";
import type { StrandedSpawnClassification } from "../src/no-idling/stranded-spawn-classification.ts";
import {
  countInFlightRecipientPaneLocks,
  RECIPIENT_PANE_LOCK_DIRECTORY_ENV,
  RecipientPaneLockService,
} from "../src/shared-policy/recipient-pane-lock.service.ts";

const SOURCE_ROOT = path.join(import.meta.dirname, "..", "src");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const LOCKING_CALLS = new Set(["writeToPaneHoldingItsLock", "withRecipientPaneLock"]);
const PANE_WRITE_COMMANDS: readonly (readonly [string, string])[] = [
  ["pane", "send-text"],
  ["pane", "send-keys"],
  ["pane", "run"],
  ["agent", "prompt"],
  ["agent", "send-keys"],
];
const SHELL_WRITERS_BEFORE_THE_HARNESS_STARTS: ReadonlyMap<string, string> = new Map([
  ["herdr/herdr-launch.ts", "types the launch command into the new tab's shell before any harness or agent name exists"],
  ["herdr/herdr-readiness.ts", "probes the new tab's shell before any harness or agent name exists"],
]);

const lockDirectory = await mkdtemp(path.join(tmpdir(), "composer-write-pane-lock-"));
process.env[RECIPIENT_PANE_LOCK_DIRECTORY_ENV] = lockDirectory;

const paneLocksHeldNow = () => countInFlightRecipientPaneLocks({ lockDirectory });

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(entryPath);
      const isProductionSource =
        entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts") && !entry.name.endsWith(".test.ts");
      return Promise.resolve(isProductionSource ? [entryPath] : []);
    }),
  );
  return nested.flat();
}

function isPaneWriteCommand(node: ts.Node): boolean {
  if (!ts.isArrayLiteralExpression(node)) return false;
  const [first, second] = node.elements;
  if (first === undefined || second === undefined) return false;
  if (!ts.isStringLiteral(first) || !ts.isStringLiteral(second)) return false;
  return PANE_WRITE_COMMANDS.some(([group, verb]) => first.text === group && second.text === verb);
}

function calledName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function runsInsideAPaneLock(node: ts.Node): boolean {
  for (let current = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent;
    const isCallbackOfALockingCall =
      ts.isCallExpression(parent) &&
      parent.arguments.includes(current as ts.Expression) &&
      LOCKING_CALLS.has(calledName(parent) ?? "");
    if (isCallbackOfALockingCall) return true;
  }
  return false;
}

async function paneWritesOutsideTheLock(): Promise<string[]> {
  const unlockedWrites: string[] = [];
  for (const file of await sourceFilesUnder(SOURCE_ROOT)) {
    const relativePath = path.relative(SOURCE_ROOT, file);
    if (SHELL_WRITERS_BEFORE_THE_HARNESS_STARTS.has(relativePath)) continue;
    const sourceFile = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (isPaneWriteCommand(node) && !runsInsideAPaneLock(node)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        unlockedWrites.push(`src/${relativePath}:${line} ${node.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unlockedWrites;
}

function agentOnPane(paneId: string): HerdrAgent {
  return {
    agent: "claude",
    name: "shadow-composer-lock",
    agentStatus: "idle",
    cwd: "/tmp",
    focused: false,
    paneId,
    tabId: `tab-${paneId}`,
    terminalId: `terminal-${paneId}`,
  };
}

function herdrRecordingWhenEachWriteRan(): {
  boundary: HerdrProcessBoundary;
  writesRanAt: number[];
} {
  const writesRanAt: number[] = [];
  return {
    writesRanAt,
    boundary: {
      execute: async () => {
        writesRanAt.push(Date.now());
        return { stdout: "", stderr: "" };
      },
    },
  };
}

test("every write to a harness composer holds the pane lock", async () => {
  assert.deepEqual(await paneWritesOutsideTheLock(), []);
});

test("a write to a composer waits while another task holds that pane's lock", async () => {
  const paneId = "w9:p-held-elsewhere";
  const { boundary, writesRanAt } = herdrRecordingWhenEachWriteRan();
  let releaseHolder!: () => void;
  const holderReleased = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let holderAcquired!: () => void;
  const holderHasTheLock = new Promise<void>((resolve) => {
    holderAcquired = resolve;
  });
  const holder = new RecipientPaneLockService().withRecipientPaneLock(paneId, async () => {
    holderAcquired();
    await holderReleased;
  });
  await holderHasTheLock;

  const write = sendTextInSession("throne", paneId, "hello", boundary);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const writesBeforeRelease = [...writesRanAt];
  const releasedAt = Date.now();
  releaseHolder();
  await holder;
  await write;

  assert.deepEqual(writesBeforeRelease, []);
  assert.equal(writesRanAt.length, 1);
  assert.ok(writesRanAt[0]! >= releasedAt);
});

test("a write to a composer made while its pane lock is already held does not wait for that lock again", async () => {
  const paneId = "w9:p-held-by-this-task";
  const { boundary, writesRanAt } = herdrRecordingWhenEachWriteRan();
  const startedAt = Date.now();

  await new RecipientPaneLockService().withRecipientPaneLock(
    paneId,
    () => sendTextInSession("throne", paneId, "hello", boundary),
    { acquisitionCeilingMs: 2_000 },
  );

  assert.equal(writesRanAt.length, 1);
  assert.ok(Date.now() - startedAt < 2_000);
});

async function strandedRecoveryOnFixtureScreen(
  fixture: string,
  recordedPresses: { key: string; paneLocksHeld: number | null }[],
  redelivered: string[],
): Promise<StrandedSpawnRecoveryDeps> {
  const paneLock = new RecipientPaneLockService();
  const screen = await readFile(path.join(FIXTURES, fixture), "utf8");
  return {
    resolveAgent: async () => agentOnPane("w9:p-stranded"),
    readVisibleAnsi: async () => screen,
    openingPromptExists: async () => true,
    readOpeningPrompt: async () => "the opening prompt",
    readSpawnSpec: async () => null,
    pressPaneKey: async (_paneId, key) => {
      recordedPresses.push({ key, paneLocksHeld: await paneLocksHeldNow() });
    },
    pressEnter: async () => {
      recordedPresses.push({ key: "Enter", paneLocksHeld: await paneLocksHeldNow() });
    },
    withRecipientPaneLock: paneLock.withRecipientPaneLock.bind(paneLock),
    deliverOpeningPrompt: async (_agentName, prompt) => {
      redelivered.push(prompt);
    },
  };
}

test("redelivering a stranded opening prompt answers the first-run modal while holding the pane lock", async () => {
  const presses: { key: string; paneLocksHeld: number | null }[] = [];
  const redelivered: string[] = [];
  const classification: StrandedSpawnClassification = "MODAL_BLOCKING";

  const result = await recoverStrandedSpawn(
    "shadow-composer-lock",
    classification,
    undefined,
    await strandedRecoveryOnFixtureScreen("claude-live-fleet-interactive-select-menu.ansi", presses, redelivered),
  );

  assert.equal(result.outcome, STRANDED_SPAWN_RECOVERY_OUTCOMES.REDELIVERED);
  assert.deepEqual(presses, [
    { key: "2", paneLocksHeld: 1 },
    { key: "Enter", paneLocksHeld: 1 },
  ]);
  assert.deepEqual(redelivered, ["the opening prompt"]);
});

test("submitting a stranded opening prompt left in the composer presses Enter while holding the pane lock", async () => {
  const presses: { key: string; paneLocksHeld: number | null }[] = [];
  const redelivered: string[] = [];

  const result = await recoverStrandedSpawn(
    "shadow-composer-lock",
    "PROMPT_UNSUBMITTED",
    undefined,
    await strandedRecoveryOnFixtureScreen("claude-live-fleet-resident-draft.ansi", presses, redelivered),
  );

  assert.equal(result.outcome, STRANDED_SPAWN_RECOVERY_OUTCOMES.REDELIVERED);
  assert.deepEqual(presses, [{ key: "Enter", paneLocksHeld: 1 }]);
  assert.deepEqual(redelivered, []);
});

test("an immediate delivery types its text and presses Enter while holding the pane lock", async () => {
  const { boundary } = herdrRecordingWhenEachWriteRan();
  const writes: { write: string; paneLocksHeld: number | null }[] = [];
  const deps = {
    ...buildSubmitToAgentDeps("throne", boundary),
    sendText: async () => {
      writes.push({ write: "text", paneLocksHeld: await paneLocksHeldNow() });
    },
    pressEnter: async () => {
      writes.push({ write: "Enter", paneLocksHeld: await paneLocksHeldNow() });
    },
  };

  await submitToAgent(agentOnPane("w9:p-immediate"), "regent", "a quick word", { forceImmediate: true }, deps);

  assert.deepEqual(writes, [
    { write: "text", paneLocksHeld: 1 },
    { write: "Enter", paneLocksHeld: 1 },
  ]);
});
