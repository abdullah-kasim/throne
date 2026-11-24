import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import throneStateExtension, { THRONE_CLI_VARIABLE } from "../extensions/pi/throne-pi-state.ts";
import { runMyState, type MyStateDependencies } from "../src/my-state/my-state.ts";
import { readAgentState } from "../src/agentdata/agent-state.service.ts";

const AGENT = "shadow-pistate-01";

function assistant(text: string) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function user(text: string) {
  return { type: "message", message: { role: "user", content: text } };
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  return {
    pi: {
      on: (name: string, handler: (event: unknown, context: unknown) => void) => handlers.set(name, handler),
      registerCommand: () => undefined,
    },
    emit: (name: string, context: unknown = {}) => handlers.get(name)?.({}, context),
  };
}

async function waitForLines(file: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text.split("\n").filter((line) => line !== "");
    if (lines.length >= count) return lines;
    await sleep(50);
  }
  throw new Error(`fewer than ${count} my-state calls recorded`);
}

function dependencies(dataDirectory: string, message = ""): MyStateDependencies {
  return {
    currentAgentName: async () => AGENT,
    readRole: async () => { throw new Error("unused"); },
    readMessage: async () => message,
    dataDirectory,
    print: () => undefined,
    printError: () => undefined,
    tellRegent: async () => undefined,
  };
}

test("a pi turn start calls my-state --turn-start and its settled end hands the last assistant message of that turn to my-state --turn-end", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pi-state-extension-"));
  try {
    const record = path.join(folder, "calls.jsonl");
    const cli = path.join(folder, "throne-cli");
    await writeFile(cli, `#!/usr/bin/env bash\nTHRONE_OPTION="$2" THRONE_INPUT="$(cat)" bun -e 'console.log(JSON.stringify({ option: process.env.THRONE_OPTION, input: process.env.THRONE_INPUT }))' >> ${JSON.stringify(record)}\n`);
    await chmod(cli, 0o755);
    process.env[THRONE_CLI_VARIABLE] = cli;
    const { pi, emit } = fakePi();
    throneStateExtension(pi);
    emit("agent_start");
    const branch = [user("first"), assistant('old {"reapable":"completed"}'), user("second"), assistant('done {"blocked":true} BLOCKED_BY_own-background-run (suite)')];
    emit("agent_settled", { sessionManager: { getBranch: () => branch } });
    const calls = (await waitForLines(record, 2)).map((line) => JSON.parse(line));
    assert.equal(calls[0].option, "--turn-start");
    assert.equal(calls[1].option, "--turn-end");
    assert.equal(calls[1].input, 'done {"blocked":true} BLOCKED_BY_own-background-run (suite)');
  } finally {
    delete process.env[THRONE_CLI_VARIABLE];
    await rm(folder, { recursive: true, force: true });
  }
});

test("a pi agent's state reads working by turn-start, then waiting-on-own-run from its turn-end marker, then reapable from my-state reapable completed", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "pi-state-file-"));
  try {
    await mkdir(path.join(dataDirectory, AGENT));
    assert.equal(await runMyState(["--turn-start"], dependencies(dataDirectory)), 0);
    const working = await readAgentState(AGENT, dataDirectory);
    assert.equal(working.state, "working");
    assert.equal(working.declaredBy, "turn-start");
    await runMyState(["--turn-end"], dependencies(dataDirectory, '{"blocked":true} BLOCKED_BY_own-background-run (x)'));
    const waiting = await readAgentState(AGENT, dataDirectory);
    assert.equal(waiting.state, "waiting-on-own-run");
    assert.equal(waiting.waitingOn, "x");
    await runMyState(["reapable", "completed"], dependencies(dataDirectory));
    const reapable = await readAgentState(AGENT, dataDirectory);
    assert.equal(reapable.state, "reapable");
    assert.equal(reapable.reapableReason, "completed");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
