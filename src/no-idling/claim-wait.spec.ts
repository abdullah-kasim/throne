import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACCEPTANCE_DATA, type AcceptanceMethod } from '../agentdata/acceptance-data.service.ts';
import type { LastMessageTagState } from './idle-pane-tag-classification.ts';
import { findReapabilityProtocolViolations } from './reapability-protocol.ts';
import {
  GO_AHEAD_CLAIM_LIMIT_MS,
  isAcceptedLiveAgent,
  notifySupervisorsOfClaims,
  readSupervisorWaits,
  remindAgentsToClaim,
  type ClaimWaitSweep,
} from './claim-wait.ts';
import type { ClearedChildren } from './dependency-cleared-wake.ts';
import { declareAgentState } from '../agentdata/agent-state.service.ts';
import { readSupervisorWait, SUPERVISOR_WAIT_STEPS } from '../supervisor-wait/read-supervisor-wait.ts';
import { deps, rosterEntry } from './no-idling-command-test-fixtures.ts';

const ALPHA = 'alpha-scratch-01';
const CAMPAIGN_KINDS: readonly AcceptanceMethod[] = ['merge', 'verdict'];
const SHADOWS_THE_REGENT_WAS_WRONGLY_PAGED_ABOUT = [
  'shadow-rptheadnum-02-refuse',
  'shadow-rptcheapfix-99b-verify',
  'shadow-brd510lim2-02-wired',
  'shadow-brd510lim2-05-render',
];
const SHADOW = SHADOWS_THE_REGENT_WAS_WRONGLY_PAGED_ABOUT[0]!;
const NOW_MS = Date.parse('2026-11-11T12:00:00.000Z');
const UNMARKED: LastMessageTagState = { kind: 'unmarked' };
const CLAIMED: LastMessageTagState = { kind: 'reapable' };

async function withLedger(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'claim-wait-'));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeFinishedShadow(dataDir: string, name: string): Promise<void> {
  const dir = path.join(dataDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'identity.md'),
    `# ${name}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
  );
  await writeFile(path.join(dir, 'REPORT.md'), 'DONE\n');
}

async function acceptWithGoAhead(
  dataDir: string,
  name: string,
  how: AcceptanceMethod,
  goAheadAgeMs: number,
): Promise<void> {
  const sentAt = new Date(NOW_MS - goAheadAgeMs).toISOString();
  await ACCEPTANCE_DATA.write(
    name,
    { acceptedAt: sentAt, by: ALPHA, how, goAhead: { sentAt, sendOutcome: 'enqueued' } },
    dataDir,
  );
}

async function violationsFor(
  dataDir: string,
  names: readonly string[],
  tag: LastMessageTagState = UNMARKED,
): Promise<readonly { agent: string; reason: string }[]> {
  const roster = names.map((name) => rosterEntry(name, 'Shadow', 'idle'));
  const tags = new Map(names.map((name) => [name, tag] as const));
  const waits = await readSupervisorWaits(roster, dataDir);
  return findReapabilityProtocolViolations(
    roster,
    tags,
    new Set(),
    new Set(),
    new Map(names.map((name) => [name, ALPHA] as const)),
    waits,
    NOW_MS,
  );
}

function sweepOf(
  dataDir: string,
  tags: ReadonlyMap<string, LastMessageTagState>,
  clearedDependencyWakes: ReadonlyMap<string, ClearedChildren> = new Map(),
  nowMs: number = NOW_MS,
): { sweep: ClaimWaitSweep; prompts: () => string[]; recipients: () => string[] } {
  const scene = deps();
  return {
    sweep: {
      deps: scene.dependencies,
      lastMessageTags: tags,
      supervisorNames: new Map([...tags.keys()].map((name) => [name, ALPHA] as const)),
      dataDir,
      nowMs,
      recordNotices: true,
      clearedDependencyWakes,
    },
    prompts: () => scene.submitCalls.map((call) => call.prompt),
    recipients: () => scene.submitCalls.map((call) => call.target.name ?? ''),
  };
}

test('a Shadow that never reported DONE and has no claim is still paged for having no claim', async () => {
  await withLedger(async (dataDir) => {
    assert.deepEqual(await violationsFor(dataDir, [SHADOW]), [
      { agent: SHADOW, reason: 'idle-with-no-claim' },
    ]);
  });
});

for (const how of CAMPAIGN_KINDS) {
  test(`a Shadow waiting for its Alpha to accept it is not paged for having no claim (${how})`, async () => {
    await withLedger(async (dataDir) => {
      for (const name of SHADOWS_THE_REGENT_WAS_WRONGLY_PAGED_ABOUT) {
        await writeFinishedShadow(dataDir, name);
      }
      assert.deepEqual(await violationsFor(dataDir, SHADOWS_THE_REGENT_WAS_WRONGLY_PAGED_ABOUT), []);
    });
  });

  test(`a Shadow accepted but not yet sent the go-ahead is not paged for having no claim (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await ACCEPTANCE_DATA.write(
        SHADOW,
        { acceptedAt: new Date(NOW_MS).toISOString(), by: ALPHA, how },
        dataDir,
      );
      assert.deepEqual(await violationsFor(dataDir, [SHADOW]), []);
    });
  });

  test(`a Shadow told it may claim is reminded itself, not reported, inside the limit (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await acceptWithGoAhead(dataDir, SHADOW, how, GO_AHEAD_CLAIM_LIMIT_MS - 60_000);
      assert.deepEqual(await violationsFor(dataDir, [SHADOW]), []);
      const tags = new Map([[SHADOW, UNMARKED]]);
      const { sweep, recipients, prompts } = sweepOf(dataDir, tags);
      await remindAgentsToClaim(sweep, await readSupervisorWaits([rosterEntry(SHADOW, 'Shadow', 'idle')], dataDir));
      await remindAgentsToClaim(sweep, await readSupervisorWaits([rosterEntry(SHADOW, 'Shadow', 'idle')], dataDir));
      assert.deepEqual(recipients(), [SHADOW]);
      assert.match(prompts()[0]!, /\{"reapable":"completed"\}/);
    });
  });

  test(`a Shadow told it may claim and silent past the limit is paged (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await acceptWithGoAhead(dataDir, SHADOW, how, GO_AHEAD_CLAIM_LIMIT_MS + 60_000);
      assert.deepEqual(await violationsFor(dataDir, [SHADOW]), [
        { agent: SHADOW, reason: 'idle-with-no-claim' },
      ]);
    });
  });

  test(`a child's claim wakes its supervisor once (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await acceptWithGoAhead(dataDir, SHADOW, how, 60_000);
      const tags = new Map([[SHADOW, CLAIMED]]);
      const { sweep, recipients, prompts } = sweepOf(dataDir, tags);
      await notifySupervisorsOfClaims(
        sweep,
        await readSupervisorWaits([rosterEntry(SHADOW, 'Shadow', 'idle')], dataDir),
      );
      assert.deepEqual(recipients(), [ALPHA]);
      assert.deepEqual(prompts(), [`${SHADOW} has claimed; reap it.`]);
    });
  });

  test(`the claim wake is not repeated for the same claim (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await acceptWithGoAhead(dataDir, SHADOW, how, 60_000);
      const tags = new Map([[SHADOW, CLAIMED]]);
      const roster = [rosterEntry(SHADOW, 'Shadow', 'idle')];
      const first = sweepOf(dataDir, tags);
      await notifySupervisorsOfClaims(first.sweep, await readSupervisorWaits(roster, dataDir));
      const afterRestart = sweepOf(dataDir, tags);
      await notifySupervisorsOfClaims(afterRestart.sweep, await readSupervisorWaits(roster, dataDir));
      assert.equal(first.recipients().length, 1);
      assert.deepEqual(afterRestart.recipients(), []);
    });
  });
}

for (const how of CAMPAIGN_KINDS) {
  test(`a claim made before the Alpha accepted the slice wakes nobody, and one wake follows acceptance (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      const tags = new Map([[SHADOW, CLAIMED]]);
      const roster = [rosterEntry(SHADOW, 'Shadow', 'idle')];
      const early = sweepOf(dataDir, tags);
      await notifySupervisorsOfClaims(early.sweep, await readSupervisorWaits(roster, dataDir));
      await acceptWithGoAhead(dataDir, SHADOW, how, 60_000);
      const late = sweepOf(dataDir, tags);
      await notifySupervisorsOfClaims(late.sweep, await readSupervisorWaits(roster, dataDir));
      await notifySupervisorsOfClaims(late.sweep, await readSupervisorWaits(roster, dataDir));
      assert.deepEqual(early.recipients(), []);
      assert.deepEqual(late.recipients(), [ALPHA]);
    });
  });

  test(`a supervisor already blocked on the claiming child is left to the dependency-cleared wake (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeFinishedShadow(dataDir, SHADOW);
      await acceptWithGoAhead(dataDir, SHADOW, how, 60_000);
      const tags = new Map<string, LastMessageTagState>([
        [SHADOW, CLAIMED],
        [ALPHA, { kind: 'blocked', blockedBy: [SHADOW] } as LastMessageTagState],
      ]);
      const { sweep, recipients } = sweepOf(dataDir, tags, new Map([[ALPHA, { gone: [], reapable: [SHADOW] }]]));
      await notifySupervisorsOfClaims(
        sweep,
        await readSupervisorWaits([rosterEntry(SHADOW, 'Shadow', 'idle')], dataDir),
      );
      assert.deepEqual(recipients(), []);
    });
  });
}

const PROOF_ALPHA = 'alpha-holdwaitproof-01';
const PROOF_SHADOW = 'shadow-kwp-99a-conform-run2';
const PROOF_ACCEPTED_AT = '2026-11-11T10:17:44.877Z';
const PROOF_GO_AHEAD_AT = '2026-11-11T10:17:44.901Z';
const PROOF_CLAIM_SWEEP_MS = Date.parse('2026-11-11T10:20:36.000Z');

async function writeProofShadow(dataDir: string, how: AcceptanceMethod): Promise<void> {
  const dir = path.join(dataDir, PROOF_SHADOW);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'identity.md'),
    `# ${PROOF_SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${PROOF_ALPHA}\n`,
  );
  await ACCEPTANCE_DATA.write(
    PROOF_SHADOW,
    {
      acceptedAt: PROOF_ACCEPTED_AT,
      by: PROOF_ALPHA,
      how,
      goAhead: { sentAt: PROOF_GO_AHEAD_AT, sendOutcome: 'enqueued' },
    },
    dataDir,
  );
}

function proofSweep(
  dataDir: string,
  alphaTag: LastMessageTagState,
  clearedDependencyWakes: ReadonlyMap<string, ClearedChildren>,
): { sweep: ClaimWaitSweep; recipients: () => string[]; prompts: () => string[] } {
  const scene = deps();
  return {
    sweep: {
      deps: scene.dependencies,
      lastMessageTags: new Map([
        [PROOF_SHADOW, CLAIMED],
        [PROOF_ALPHA, alphaTag],
      ]),
      supervisorNames: new Map([[PROOF_SHADOW, PROOF_ALPHA]]),
      dataDir,
      nowMs: PROOF_CLAIM_SWEEP_MS,
      recordNotices: true,
      clearedDependencyWakes,
    },
    recipients: () => scene.submitCalls.map((call) => call.target.name ?? ''),
    prompts: () => scene.submitCalls.map((call) => call.prompt),
  };
}

const BLOCKED_ON_PROOF_SHADOW: LastMessageTagState = { kind: 'blocked', blockedBy: [PROOF_SHADOW] };
const PROOF_ROSTER = [rosterEntry(PROOF_SHADOW, 'Shadow', 'working')];

for (const how of CAMPAIGN_KINDS) {
  test(`a verdict-only Shadow's claim wakes its supervisor at the next sweep (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeProofShadow(dataDir, how);
      assert.equal(await isAcceptedLiveAgent(PROOF_ROSTER[0]!, dataDir), true);
      const { sweep, recipients, prompts } = proofSweep(dataDir, BLOCKED_ON_PROOF_SHADOW, new Map());
      await notifySupervisorsOfClaims(sweep, await readSupervisorWaits(PROOF_ROSTER, dataDir));
      assert.deepEqual(recipients(), [PROOF_ALPHA]);
      assert.deepEqual(prompts(), [`${PROOF_SHADOW} has claimed; reap it.`]);
    });
  });

  test(`a claim wakes a supervisor that is blocked on the child exactly once (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeProofShadow(dataDir, how);
      const clearedThisSweep = new Map([[PROOF_ALPHA, { gone: [], reapable: [PROOF_SHADOW] }]]);
      const wokenSweep = proofSweep(dataDir, BLOCKED_ON_PROOF_SHADOW, clearedThisSweep);
      await notifySupervisorsOfClaims(
        wokenSweep.sweep,
        await readSupervisorWaits(PROOF_ROSTER, dataDir),
      );
      const nextSweep = proofSweep(dataDir, { kind: 'unmarked' }, new Map());
      await notifySupervisorsOfClaims(
        nextSweep.sweep,
        await readSupervisorWaits(PROOF_ROSTER, dataDir),
      );
      assert.deepEqual([...wokenSweep.recipients(), ...nextSweep.recipients()], []);
    });
  });

  test(`a claimed Shadow's wait is counted from its claim (${how})`, async () => {
    await withLedger(async (dataDir) => {
      await writeProofShadow(dataDir, how);
      const { sweep } = proofSweep(dataDir, { kind: 'unmarked' }, new Map());
      await notifySupervisorsOfClaims(sweep, await readSupervisorWaits(PROOF_ROSTER, dataDir));
      await declareAgentState(PROOF_SHADOW, { state: 'reapable', reapableReason: 'completed', declaredBy: 'agent' }, dataDir);
      const wait = await readSupervisorWait({ agentName: PROOF_SHADOW, dataDir });
      assert.deepEqual(wait, {
        waiting: true,
        step: SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP,
        supervisor: PROOF_ALPHA,
        since: new Date(PROOF_CLAIM_SWEEP_MS),
      });
    });
  });
}
