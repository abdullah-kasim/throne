import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TOPIC_FILE_NAME, TOPIC_VERDICTS_FILE_NAME, runTopic, type TopicDependencies } from "./topic.command.ts";

const RECORDED_AT = new Date("2026-11-24T10:00:00.000Z");

async function courtWith(name: string, role: string) {
  const ledgerDirectory = await mkdtemp(path.join(os.tmpdir(), "topic-"));
  await mkdir(path.join(ledgerDirectory, name));
  await writeFile(path.join(ledgerDirectory, name, "identity.md"), `# Identity — ${name}\n\n- **Role:** ${role}\n`);
  const errors: string[] = [];
  const dependencies: TopicDependencies = {
    agentLedgerDirectory: ledgerDirectory,
    tabAgentName: name,
    now: () => RECORDED_AT,
    writeStdout: () => {},
    writeStderr: (text) => errors.push(text),
  };
  const readLedger = (file: string) => readFile(path.join(ledgerDirectory, name, file), "utf8");
  return { dependencies, errors, readLedger };
}

test("a Stager recording the same topic appends a same verdict", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["same", "--description", "the boards"], court.dependencies), 0);
  assert.equal(await runTopic(["same"], court.dependencies), 0);
  const records = (await court.readLedger(TOPIC_VERDICTS_FILE_NAME)).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.at(-1), { verdict: "same", at: RECORDED_AT.toISOString() });
  assert.equal(records.length, 2);
});

test("a Stager naming a topic saves it to its topic file", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["none", "--description", "the power board layout"], court.dependencies), 0);
  assert.equal(await court.readLedger(TOPIC_FILE_NAME), "the power board layout\n");
});

test("a Stager recording a changed topic must name it", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed"], court.dependencies), 2);
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 0);
  const record = JSON.parse((await court.readLedger(TOPIC_VERDICTS_FILE_NAME)).trim());
  assert.deepEqual(record, { verdict: "changed", slug: "web-ui", at: RECORDED_AT.toISOString() });
});

test("a Stager handing over a changed topic keeps its own saved topic", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["same", "--description", "the keyboard pcb repo"], court.dependencies), 0);
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 0);
  assert.equal(await court.readLedger(TOPIC_FILE_NAME), "the keyboard pcb repo\n");
});

test("a changed verdict with a description is refused and records nothing", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "web-ui", "--description", "the web ui"], court.dependencies), 2);
  assert.match(court.errors.join(""), /drop --description/);
  await assert.rejects(court.readLedger(TOPIC_FILE_NAME));
  await assert.rejects(court.readLedger(TOPIC_VERDICTS_FILE_NAME));
});

test("the topic command refuses outside a Stager session", async () => {
  const court = await courtWith("alpha-boards-01", "Alpha");
  assert.equal(await runTopic(["none"], court.dependencies), 1);
  assert.match(court.errors.join(""), /only a registered Stager/);
  await assert.rejects(court.readLedger(TOPIC_VERDICTS_FILE_NAME));
});
