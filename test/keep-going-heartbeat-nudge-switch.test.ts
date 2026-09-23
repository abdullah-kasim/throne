import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { HerdrAgent, KeepGoingDependencies } from "../src/keep-going/keep-going-context.ts";
import { DESIRED_STATES, UNTHROTTLED_EVALUATION } from "../src/keep-going/keep-going-context.ts";
import { tendRegent } from "../src/keep-going/keep-going-regent-tending.ts";
import { readRegentHeartbeatNudgeEnabledInUserConfig } from "../src/keep-going/regent-heartbeat-nudge-switch.ts";

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const LIVE_REGENT = { name: "Regent", agent: "claude", paneId: "w1:p1" } as unknown as HerdrAgent;

interface Tick {
  nudges: number;
  resurrections: number;
  lines: string[];
  deps: KeepGoingDependencies;
}

function tick(options: { regent: HerdrAgent | null; nudgeEnabled: boolean; stalledFamilies?: number }): Tick {
  const state: Tick = { nudges: 0, resurrections: 0, lines: [], deps: undefined as unknown as KeepGoingDependencies };
  const staleAlphas = new Set(Array.from({ length: options.stalledFamilies ?? 0 }, (_, index) => `alpha-stalled-0${index + 1}`));
  state.deps = {
    findLiveRegent: async () => options.regent,
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    resurrectRegent: async () => { state.resurrections += 1; },
    evaluateThrottle: async () => UNTHROTTLED_EVALUATION,
    evaluateRegentFence: async () => ({ action: "no-op", reason: "kill switch off" }),
    isRegentHeartbeatNudgeEnabled: async () => options.nudgeEnabled,
    resolveHeartbeatRoot: async () => "/nonexistent",
    getRoster: async () => [],
    readStallEvidence: async () => ({ roster: [], supervisors: new Map(), staleAlphas }),
    now: () => new Date("2026-09-21T02:00:00Z"),
    stdout: (text: string) => { state.lines.push(text); },
    stderr: (text: string) => { state.lines.push(text); },
  } as unknown as KeepGoingDependencies;
  return state;
}

const countNudge = (state: Tick) => async () => { state.nudges += 1; };

test("a live Regent is left alone when the heartbeat nudge is off", async () => {
  const state = tick({ regent: LIVE_REGENT, nudgeEnabled: false });
  assert.equal(await tendRegent(state.deps, countNudge(state)), 0);
  assert.equal(state.nudges, 0);
  assert.equal(state.resurrections, 0);
  assert.match(state.lines.join(""), /heartbeat nudge is off/);
});

test("a dead Regent is still resurrected when the heartbeat nudge is off", async () => {
  const state = tick({ regent: null, nudgeEnabled: false });
  assert.equal(await tendRegent(state.deps, countNudge(state)), 0);
  assert.equal(state.resurrections, 1);
  assert.equal(state.nudges, 0);
});

test("a live Regent is nudged when the heartbeat nudge is on", async () => {
  const state = tick({ regent: LIVE_REGENT, nudgeEnabled: true });
  assert.equal(await tendRegent(state.deps, countNudge(state)), 0);
  assert.equal(state.nudges, 1);
});

test("a stalled family is still reported to a live Regent while the heartbeat nudge is off", async () => {
  const state = tick({ regent: LIVE_REGENT, nudgeEnabled: false, stalledFamilies: 1 });
  assert.equal(await tendRegent(state.deps, countNudge(state)), 0);
  assert.equal(state.nudges, 1);
});

async function configFile(steeringBody: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "heartbeat-nudge-"));
  scratch.push(dir);
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}\n');
  const file = path.join(dir, "config.user.ts");
  await writeFile(file, `export default { steering: { ${steeringBody} } };\n`);
  return file;
}

test("the switch is off when the config does not mention it", async () => {
  assert.equal(await readRegentHeartbeatNudgeEnabledInUserConfig(await configFile("")), false);
});

test("the switch follows the config and is read fresh on every call", async () => {
  const file = await configFile("regentHeartbeatNudgeEnabled: true");
  assert.equal(await readRegentHeartbeatNudgeEnabledInUserConfig(file), true);
  await writeFile(file, "export default { steering: { regentHeartbeatNudgeEnabled: false } };\n");
  assert.equal(await readRegentHeartbeatNudgeEnabledInUserConfig(file), false);
});
