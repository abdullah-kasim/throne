#!/usr/bin/env node
// herdr-repair-identities — put agent names back after a herdr server restart.
//
// A restart does NOT kill agent panes (a confident process-tree prediction
// said it would; it was wrong). What it DOES destroy is agent name
// registration, which is server-side state. With the names gone the boot
// ritual finds no named Regent and renames the FIRST AVAILABLE pane to
// `regent` -- on 2026-08-24 that was the Stager's pane, leaving the real
// codex Regent unnamed. An unnamed Regent cannot send, cannot receive an
// escalation, and cannot be resurrected by name.
//
// Ownership is decided by `agent_session.value`, never by pane order or by
// which pane happens to be free. That value is the harness's own session id
// and is stable across the restart, so it is the only trustworthy link
// between "this pane" and "who was here before".
//
//   node scripts/herdr-repair-identities.mjs '<snapshot json>' <herdr binary>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [snapshotJson, binary] = process.argv.slice(2);
const SESSION = 'throne';

if (!snapshotJson || !binary) {
  process.stderr.write('usage: herdr-repair-identities.mjs <snapshot json> <herdr binary>\n');
  process.exit(2);
}

const wanted = JSON.parse(snapshotJson).filter((e) => e.session && e.name);
const herdr = async (args) =>
  (await execFileAsync(binary, ['--session', SESSION, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout;

const live = JSON.parse(await herdr(['agent', 'list'])).result.agents;
const bySession = new Map(live.map((a) => [a.agent_session?.value, a]));

// Resolve what each pane SHOULD be called, by session identity alone.
const plan = [];
for (const entry of wanted) {
  const pane = bySession.get(entry.session);
  if (!pane) {
    process.stdout.write(`repair: "${entry.name}" session ${entry.session.slice(0, 8)} is gone; not recreating it\n`);
    continue;
  }
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

const after = JSON.parse(await herdr(['agent', 'list'])).result.agents;
process.stdout.write('repair: final mapping\n');
for (const a of after) {
  process.stdout.write(`  ${a.name ?? '(unnamed)'}  ${a.pane_id}  ${a.agent}\n`);
}
const missing = wanted.filter((w) => !after.some((a) => a.name === w.name && a.agent_session?.value === w.session));
if (missing.length > 0) {
  process.stderr.write(`repair: STILL WRONG for ${missing.map((m) => m.name).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('repair: every snapshotted identity restored to its own session\n');
