// The requirement: a message sent to a WORKING omp agent must not cancel the
// tool call it is in the middle of.
//
// The defect these cover, measured 2026-08-27 in the live Regent's scrollback:
// 19 skipped tool calls against 17 incoming messages in 1000 lines, the same
// `Eval` cancelled three times running. Cause: the extension called
// `sendUserMessage(text)` with no options, and omitted `deliverAs` means
// "start a turn when idle, queue as a STEER while streaming" — a steer preempts
// the turn it lands in and omp drops the pending tool calls to service it.
//
// These drive the REAL extension module against a real temp filesystem. `pi`
// and `ctx` are omp's runtime, i.e. the boundary this process does not own, so
// they are the only things stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The extension's poll interval; a couple of ticks is well inside the
 *  ten-second-per-item bound. */
const POLL_MILLISECONDS = 500;

interface SentMessage {
  readonly text: string;
  readonly options: unknown;
}

type ExtensionEventHandler = (event: string, ctx: unknown) => void;

interface FakeOmp {
  readonly pi: unknown;
  readonly ctx: unknown;
  /** What the extension asked omp to deliver, in order. */
  readonly sent: SentMessage[];
  /** Lifecycle handlers the extension registered, so a test can hand it a ctx
   *  the way a live session does. */
  readonly handlers: ExtensionEventHandler[];
}

interface FakeOmpOptions {
  /** omp's own answer to `ctx.isIdle()`; `undefined` omits the method entirely,
   *  standing in for a ctx that cannot be asked. */
  readonly idle: boolean | undefined;
  /** The composer's contents; empty means no resident draft. */
  readonly draft?: string;
}

function fakeOmp(options: FakeOmpOptions): FakeOmp {
  const sent: SentMessage[] = [];
  const handlers: ExtensionEventHandler[] = [];
  const ctx = {
    ui: { getEditorText: () => options.draft ?? "" },
    ...(options.idle === undefined ? {} : { isIdle: () => options.idle }),
  };
  const pi = {
    on: (_event: string, handler: ExtensionEventHandler) => {
      handlers.push(handler);
    },
    sendUserMessage: (text: string, sendOptions?: unknown) => {
      sent.push({ text, options: sendOptions });
    },
  };
  return { pi, ctx, sent, handlers };
}

/** Loads a fresh extension instance bound to `directory` and `paneId`, hands it
 *  the fake omp, and lets it capture a ctx the way a live session would. */
async function startExtension(
  directory: string,
  paneId: string,
  omp: FakeOmp,
): Promise<void> {
  const previousDirectory = process.env.THRONE_OMP_DELIVERY_DIR;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.THRONE_OMP_DELIVERY_DIR = directory;
  process.env.HERDR_PANE_ID = paneId;
  try {
    // Dynamic by necessity, not preference: the extension reads its directory
    // and pane id from the environment AT MODULE LOAD, so each case needs its
    // own instance, and a static import would bind all four to whichever
    // environment happened to be set first.
    const specifier = `${new URL("../extensions/omp/throne-omp-delivery.ts", import.meta.url).href}?instance=${paneId}`;
    const loaded: unknown = await import(specifier);
    assert.ok(
      loaded !== null && typeof loaded === "object" && "default" in loaded,
      "the extension must default-export its factory",
    );
    const factory = loaded.default;
    assert.equal(typeof factory, "function");
    (factory as (pi: unknown) => void)(omp.pi);
  } finally {
    if (previousDirectory === undefined) delete process.env.THRONE_OMP_DELIVERY_DIR;
    else process.env.THRONE_OMP_DELIVERY_DIR = previousDirectory;
    if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previousPane;
  }
  // A real session hands ctx to handlers on turn_start and friends; without one
  // the composer is unreadable and the extension holds every request.
  for (const handler of omp.handlers) handler("turn_start", omp.ctx);
}

async function writeRequest(
  directory: string,
  paneId: string,
  id: string,
  text: string,
): Promise<void> {
  await writeFile(
    join(directory, `req-${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}-${id}.json`),
    JSON.stringify({ id, text, paneId }),
  );
}

/** Waits for the extension to consume the request, and returns the ack's
 *  status. */
async function waitForAckStatus(directory: string, id: string): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(POLL_MILLISECONDS / 2);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, `ack-${id}.json`), "utf8"));
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && "status" in parsed) {
      return parsed.status;
    }
    throw new Error(`ack for ${id} carries no status`);
  }
  throw new Error(`no ack for ${id}`);
}

async function hasPendingRequest(directory: string): Promise<boolean> {
  return (await readdir(directory)).some((entry) => entry.startsWith("req-"));
}

test("a message sent to a working agent is queued as a follow-up, never a steer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-followup-"));
  const paneId = "w2:pWORKING";
  try {
    const omp = fakeOmp({ idle: false });
    await startExtension(directory, paneId, omp);
    await writeRequest(directory, paneId, "busy-1", "your child finished; inspect once");

    assert.equal(await waitForAckStatus(directory, "busy-1"), "delivered");
    assert.equal(omp.sent.length, 1);
    assert.equal(omp.sent[0]?.text, "your child finished; inspect once");
    assert.deepEqual(
      omp.sent[0]?.options,
      { deliverAs: "followUp" },
      "a working agent must be given a follow-up: omitted options mean a steer, " +
        "which preempts the turn and drops its pending tool calls",
    );
    assert.equal(
      await hasPendingRequest(directory),
      false,
      "the request must be consumed, not left to be delivered twice",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a message sent to an idle agent starts a turn immediately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-idle-"));
  const paneId = "w2:pIDLE";
  try {
    const omp = fakeOmp({ idle: true });
    await startExtension(directory, paneId, omp);
    await writeRequest(directory, paneId, "idle-1", "continue any active work");

    assert.equal(await waitForAckStatus(directory, "idle-1"), "delivered");
    assert.equal(omp.sent.length, 1);
    assert.equal(
      omp.sent[0]?.options,
      undefined,
      "an idle agent must get OMITTED options, the only path that starts a turn; " +
        "followUp never starts one, so the message would sit unread",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an agent whose turn state cannot be read is still delivered to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-unknown-"));
  const paneId = "w2:pUNKNOWN";
  try {
    // No isIdle on ctx: an older omp, or a ctx captured before the API existed.
    const omp = fakeOmp({ idle: undefined });
    await startExtension(directory, paneId, omp);
    await writeRequest(directory, paneId, "unknown-1", "status prod");

    assert.equal(await waitForAckStatus(directory, "unknown-1"), "delivered");
    assert.equal(omp.sent.length, 1);
    assert.equal(
      omp.sent[0]?.options,
      undefined,
      "unknown state must fail TOWARD delivery: the worst case is the preempt " +
        "this change removes, which beats a message that never arrives",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resident draft still outranks every sender, whatever the turn state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-draft-"));
  const paneId = "w2:pDRAFT";
  try {
    const omp = fakeOmp({ idle: false, draft: "half-typed thought" });
    await startExtension(directory, paneId, omp);
    await writeRequest(directory, paneId, "draft-1", "this must wait");

    await sleep(POLL_MILLISECONDS * 3);
    assert.equal(omp.sent.length, 0, "a human mid-sentence outranks the court");
    assert.equal(
      await hasPendingRequest(directory),
      true,
      "the request must be HELD, not consumed and not acked",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
