import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TOPIC_FILE_NAME, TOPIC_VERDICTS_FILE_NAME, runTopic, type TopicDependencies } from "./topic.command.ts";
import type { HandOverDependencies } from "./topic-hand-over.ts";

const LORD_PROMPT = "now look at the web ui\nand its colours";

const RECORDED_AT = new Date("2026-11-24T10:00:00.000Z");

async function courtWith(name: string, role: string, handOver: Partial<HandOverDependencies> = {}) {
  const ledgerDirectory = await mkdtemp(path.join(os.tmpdir(), "topic-"));
  await mkdir(path.join(ledgerDirectory, name));
  await writeFile(path.join(ledgerDirectory, name, "identity.md"), `# Identity — ${name}\n\n- **Role:** ${role}\n`);
  const errors: string[] = [];
  const output: string[] = [];
  const live = new Map<string, string>();
  const relayed: Array<[string, string]> = [];
  const launches: string[][] = [];
  const dependencies: TopicDependencies = {
    agentLedgerDirectory: ledgerDirectory,
    tabAgentName: name,
    now: () => RECORDED_AT,
    writeStdout: (text) => output.push(text),
    writeStderr: (text) => errors.push(text),
    handOver: {
      findLivePane: async (agent) => live.get(agent),
      readLordPrompt: async () => LORD_PROMPT,
      relay: async (agent, prompt) => {
        relayed.push([agent, prompt]);
      },
      prepareWorktree: async (fork) => `/trees/${fork}`,
      launch: async (createAgentArguments) => {
        launches.push(createAgentArguments);
        live.set(createAgentArguments[createAgentArguments.indexOf("--name") + 1] as string, "w1:p9");
      },
      ...handOver,
    },
  };
  const readLedger = (file: string) => readFile(path.join(ledgerDirectory, name, file), "utf8");
  const readFork = (fork: string, file: string) => readFile(path.join(ledgerDirectory, fork, file), "utf8");
  return { dependencies, errors, output, live, relayed, launches, readLedger, readFork };
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

test("a changed topic with no live Stager writes the fork's brief and launches the fork", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "web-ui", "--brief", "keep the dark theme"], court.dependencies), 0);
  const brief = await court.readFork("stager-web-ui", "brief.md");
  for (const marker of ["INTENT:", "SCOPE:", "RULINGS: keep the dark theme", "VERIFIED-NOUNS:", "REUSE:"]) assert.ok(brief.includes(marker), marker);
  assert.ok(brief.includes("> now look at the web ui\n> and its colours"));
  assert.deepEqual(court.launches, [
    ["--topic-from", "stager-boards", "--role", "Stager", "--supervisor", "Regent", "--name", "stager-web-ui", "--cwd", "/trees/stager-web-ui", "--non-campaign"],
  ]);
  assert.match(court.output.join(""), /forked stager-web-ui, pane w1:p9/);
});

test("a fork's brief with nothing settled says so", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 0);
  assert.match(await court.readFork("stager-web-ui", "brief.md"), /RULINGS: nothing settled/);
});

test("a fork's name is trimmed to fit Herdr's name limit", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "a-very-long-topic-slug-that-overflows"], court.dependencies), 0);
  assert.equal(court.launches[0]?.[7], "stager-a-very-long-topic-slug-th");
});

test("a changed topic with a live Stager of that name relays the Lord's prompt instead of forking", async () => {
  const court = await courtWith("stager-boards", "Stager");
  court.live.set("stager-web-ui", "w2:p3");
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 0);
  assert.deepEqual(court.relayed, [["stager-web-ui", LORD_PROMPT]]);
  assert.deepEqual(court.launches, []);
  await assert.rejects(court.readFork("stager-web-ui", "brief.md"));
  assert.match(court.output.join(""), /relayed the Lord's prompt to stager-web-ui, pane w2:p3/);
});

test("a fork step that fails names the step and keeps the verdict", async () => {
  const court = await courtWith("stager-boards", "Stager", {
    prepareWorktree: async () => {
      throw new Error("spawn-git-tree exited 1");
    },
  });
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 1);
  assert.match(court.errors.join(""), /topic: worktree failed: spawn-git-tree exited 1/);
  assert.deepEqual(court.launches, []);
  const record = JSON.parse((await court.readLedger(TOPIC_VERDICTS_FILE_NAME)).trim());
  assert.equal(record.verdict, "changed");
});

test("a fork with no readable Lord's prompt fails at the brief step", async () => {
  const court = await courtWith("stager-boards", "Stager", { readLordPrompt: async () => undefined });
  assert.equal(await runTopic(["changed", "web-ui"], court.dependencies), 1);
  assert.match(court.errors.join(""), /topic: brief failed: the Lord's prompt could not be read/);
});

test("a fork's name trimmed at a hyphen drops the trailing hyphen", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "aaaaaaaaaaaaaaaaaaaaaaaa-bbbb"], court.dependencies), 0);
  assert.equal(court.launches[0]?.[7], "stager-aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a changed slug that cannot name an agent is refused before anything is recorded", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["changed", "Web UI"], court.dependencies), 2);
  assert.match(court.errors.join(""), /lowercase ASCII/);
  assert.deepEqual(court.launches, []);
  await assert.rejects(court.readLedger(TOPIC_VERDICTS_FILE_NAME));
});

test("--brief goes only with a changed verdict", async () => {
  const court = await courtWith("stager-boards", "Stager");
  assert.equal(await runTopic(["none", "--brief", "x"], court.dependencies), 2);
  await assert.rejects(court.readLedger(TOPIC_VERDICTS_FILE_NAME));
});
