#!/usr/bin/env bun
// herdr-repair-identities — restart the herdr server and bring the court back.
//
// The resurrect lock is taken before the restart steps run and held until the
// Regent is relaunched, so nothing seats a Regent on the empty roster. A restart ends every pane process and clears agent name registration; the
// panes and tabs come back holding fresh shells. So every snapshotted agent
// whose harness session is gone is relaunched into its own session in its own
// tab, and any pane still holding a snapshotted session gets its name back.
// With the names gone the boot ritual finds no named Regent and renames the
// FIRST AVAILABLE pane to `regent` -- on 2026-08-24 that was the Stager's pane.
//
// A surviving pane's owner is decided by its harness session, never by pane
// order or by which pane happens to be free. The closing check is that each
// name sits on a pane with a live harness; a session id that differs after a
// resume is not a failure.
//
//   bun scripts/herdr-repair-identities.mjs '<snapshot json>' <herdr binary> '<restart steps>'

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const REPO = path.resolve(import.meta.dirname, '..');
const {
  REAL_RESUME_AFTER_RESTART_DEPS,
  agentsTheRestartEnded,
  namesWithoutLiveHarness,
  restartServerThenRepairCourt,
  resumeAgentsAfterServerRestart,
} = await import(path.join(REPO, 'dist', 'src', 'herdr-update', 'herdr-upgrade-resume.js'));
const { parseAgentList } = await import(path.join(REPO, 'dist', 'src', 'herdr', 'herdr-inventory.service.js'));

const execFileAsync = promisify(execFile);
const [snapshotJson, binary, restartSteps] = process.argv.slice(2);
const SESSION = 'throne';

if (!snapshotJson || !binary || !restartSteps) {
  process.stderr.write('usage: herdr-repair-identities.mjs <snapshot json> <herdr binary> <restart steps>\n');
  process.exit(2);
}

const snapshot = JSON.parse(snapshotJson);
const herdr = async (args) =>
  (await execFileAsync(binary, ['--session', SESSION, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;

async function repairCourt(lockIsHeld) {
  const liveList = await herdr(['agent', 'list']);
  const live = JSON.parse(liveList).result.agents;
  const ended = agentsTheRestartEnded(snapshot, parseAgentList(liveList));
  const survivors = snapshot.filter((entry) => !ended.includes(entry));
  const bySession = new Map(live.map((a) => [a.agent_session?.value, a]));

  // Resolve what each pane SHOULD be called, by session identity alone.
  const plan = [];
  for (const entry of survivors) {
    const pane = bySession.get(entry.sessionId);
    if (pane.name === entry.name) {
      process.stdout.write(`repair: "${entry.name}" already correct at ${pane.pane_id}\n`);
      continue;
    }
    plan.push({ paneId: pane.pane_id, from: pane.name ?? '(unnamed)', to: entry.name });
  }

  // Free every contested name FIRST. Renaming A->B while B is still held by
  // another pane fails `agent_name_taken`, and the obvious repair order
  // (Regent first) is exactly the order that hits it -- the wrong pane is
  // usually the one squatting the name you need.
  const claimed = new Set(live.map((a) => a.name).filter(Boolean));
  const targets = new Set(plan.map((p) => p.to));
  for (const squatter of live) {
    if (!squatter.name || !targets.has(squatter.name)) continue;
    const rightful = plan.find((p) => p.to === squatter.name);
    if (rightful?.paneId === squatter.pane_id) continue;
    const parked = `stale-${squatter.name}-${squatter.pane_id.replace(/\W/g, '')}`;
    process.stdout.write(`repair: parking squatter ${squatter.pane_id} "${squatter.name}" -> "${parked}"\n`);
    await herdr(['agent', 'rename', squatter.pane_id, parked]);
    claimed.delete(squatter.name);
  }

  for (const step of plan) {
    process.stdout.write(`repair: ${step.paneId} "${step.from}" -> "${step.to}"\n`);
    await herdr(['agent', 'rename', step.paneId, step.to]);
  }

  const outcomes = await resumeAgentsAfterServerRestart(ended, lockIsHeld, REAL_RESUME_AFTER_RESTART_DEPS);

  const after = JSON.parse(await herdr(['agent', 'list'])).result.agents;
  process.stdout.write('repair: final mapping\n');
  for (const a of after) {
    process.stdout.write(`  ${a.name ?? '(unnamed)'}  ${a.pane_id}  ${a.agent}\n`);
  }
  const missing = await namesWithoutLiveHarness(snapshot, REAL_RESUME_AFTER_RESTART_DEPS);
  if (missing.length > 0) {
    process.stderr.write(`repair: STILL WRONG for ${missing.join(', ')}\n`);
    return 1;
  }
  const failed = outcomes.filter((outcome) => outcome.verdict === 'failed').map((outcome) => outcome.name);
  if (failed.length > 0) {
    process.stderr.write(`repair: FAILED: the relaunch of ${failed.join(', ')} reported a failure\n`);
    return 1;
  }
  process.stdout.write('repair: every snapshotted name sits on a pane with a live harness\n');
  return 0;
}

process.exit(await restartServerThenRepairCourt(restartSteps, repairCourt, REAL_RESUME_AFTER_RESTART_DEPS));
