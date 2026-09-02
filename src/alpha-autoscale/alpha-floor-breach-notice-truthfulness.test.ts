// Requirement: the Alpha-floor breach notice may only claim a spawn that
// actually happened.
//
// THE INCIDENT THIS PINS: `alpha-autoscale` paged the Regent with
// `This tick spawned "alpha-acp-alpha-claim-protocol" for objective "acp"`
// and nothing had been spawned -- no ledger directory, no archived ledger
// under `.reaped` (which rules out spawned-then-reaped, since a reap
// archives rather than deletes), and the `acp` queue row still `open`. The
// cause was ordering, not a bad string: the notice was rendered from the
// tick's DECISION and sent before any spawn work ran, so all seven
// post-decision failure paths still produced a page asserting success. The
// floor mechanism exists to notice an unfilled floor; reporting a filled one
// it cannot vouch for is the precise failure it was built to prevent.
//
// These drive the real `AlphaAutoscaleHostedWorker.runOnce()` against a
// stubbed I/O boundary, so the sweep under test is the production one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AlphaAutoscaleHostedWorker,
  type AlphaAutoscaleDependencies,
} from "./alpha-autoscale.hosted-worker.ts";
import { buildFloorBreachNotice } from "./alpha-floor-notify.ts";
import type { LaunchQueueCandidate } from "../alpha-launch-queue/ready-queue.ts";

const CANDIDATE = {
  name: "alpha-acp-alpha-claim-protocol",
  // The `QueuedAlphaCandidate` half. Without these, `admitQueuedAlpha`
  // classifies the candidate `dependency-gated` and the tick refuses long
  // before any spawn path runs -- a refusal that is itself truthful, and so
  // silently makes every assertion below untestable.
  target: "/example/repos/throne",
  dependencyReady: true,
  executableWork: true,
  harness: "claude",
  model: "opus",
  objectiveCode: "acp",
  targetRepo: "/example/repos/throne",
  targetBranch: "main",
  baseCommit: "0e894bd6",
  objective: "make the claim protocol observable",
} as unknown as LaunchQueueCandidate;

/** A tick that breaches the floor (zero live Alphas) and decides to spawn.
 *  `sent` collects every breach page the tick actually delivered, and
 *  `order` records page sends interleaved with CLI invocations so the test
 *  can prove the page is an observation rather than an intention. */
function breachingSpawnTick(
  invokeCli: AlphaAutoscaleDependencies["invokeCli"],
): {
  worker: AlphaAutoscaleHostedWorker;
  sent: string[];
  order: string[];
} {
  const sent: string[] = [];
  const order: string[] = [];
  const dependencies: AlphaAutoscaleDependencies = {
    log: () => {},
    notifyOfFloorBreach: {
      resolveAgent: async () => ({ paneId: "test-pane" }) as never,
      submitToAgent: async (_target, _sender, prompt) => {
        order.push("page-sent");
        sent.push(prompt);
      },
    },
    promoteDeferredWork: () => ({
      released: [],
      recovered: null,
      overriddenAuthority: null,
    }),
    notifyOfIdleRecovery: async () => {},
    readPressure: () => ({ verdict: "take-more-work", pressure: 0, reasons: [] }),
    readReadyQueue: () => ({ state: "candidates", candidates: [CANDIDATE] }),
    autoBriefEligibleItems: () => ({ state: "staged", count: 0 }),
    // THE NAME READS BACKWARDS: `killSwitchOn: true` means autoscale is
    // ENABLED, not killed (`if (!input.killSwitchOn) skip`). `false` here
    // refuses at the switch before any spawn path is reached, and the tick
    // never gets far enough to test anything this file cares about.
    readKillSwitch: () => true,
    readSpawnCooldown: () => ({ elapsed: true }),
    recordSuccessfulSpawn: () => {},
    // Zero live Alphas against a non-zero floor is the breach.
    readActiveCapacityInputs: async () => ({ activeRecords: [], mutatingTargets: [] }),
    readLaunchLedger: async () => ({ state: "entries", entries: [] }) as never,
    resolvePublishedRuntime: () => ({ repoRoot: "/example/repos/throne" }) as never,
    invokeCli: async (...args) => {
      order.push(`cli:${String(args[1]?.[1] ?? "?")}`);
      return invokeCli(...args);
    },
  };
  return { worker: new AlphaAutoscaleHostedWorker(dependencies), sent, order };
}

const TREE_OK = {
  outcome: "success",
  result: { exitCode: 0, stdout: "/example/worktrees/throne/acp\n", stderr: "" },
} as never;

test("a floor-breach page never claims a spawn that create-agent refused", async () => {
  const { worker, sent, order } = breachingSpawnTick(async (_bin, args) =>
    args[1] === "spawn-git-tree"
      ? TREE_OK
      : ({
          outcome: "failure",
          result: { exitCode: 1, stdout: "", stderr: "role pool exhausted" },
        } as never),
  );

  await worker.runOnce();

  assert.equal(sent.length, 1, "the breached tick must still page the Regent exactly once");
  const notice = sent[0]!;
  // The whole defect in one assertion: the page must not assert the spawn.
  assert.doesNotMatch(
    notice,
    /This tick spawned "alpha-acp-alpha-claim-protocol"/,
    `page claimed a spawn that never happened: ${notice}`,
  );
  assert.match(notice, /FAILED to spawn/);
  assert.match(notice, /create-agent/);
  assert.match(notice, /role pool exhausted/);
  assert.match(notice, /no Alpha was created/);
  // Same guarantee one step deeper: this page describes what `create-agent`
  // did, so it must be emitted after `create-agent` returned.
  assert.deepEqual(order, ["cli:spawn-git-tree", "cli:create-agent", "page-sent"]);
});

test("a floor-breach page never claims a spawn that spawn-git-tree refused, and is emitted after it", async () => {
  const { worker, sent, order } = breachingSpawnTick(
    async () =>
      ({
        outcome: "failure",
        result: { exitCode: 128, stdout: "", stderr: "fatal: invalid reference" },
      }) as never,
  );

  await worker.runOnce();

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]!, /This tick spawned/, sent[0]!);
  assert.match(sent[0]!, /FAILED to spawn .* at spawn-git-tree/);
  assert.match(sent[0]!, /invalid reference/);
  // THE ORDERING GUARANTEE LIVES HERE, and it has to live in a test where a
  // page is actually sent. A page describing what a CLI step did must be
  // emitted AFTER that step returned, or it is asserting an intention rather
  // than an observation — the exact defect (objective `acp`) this whole file
  // was written for. It used to be asserted on the success path; success no
  // longer pages, so asserting it there would have quietly stopped covering
  // anything. `page-sent` must appear in an asserted order array somewhere,
  // positioned after the step whose result the page describes.
  assert.deepEqual(order, ["cli:spawn-git-tree", "page-sent"]);
});

test("a successful spawn pages nobody, and still runs its CLI steps in order", async () => {
  // CONTRACT CHANGE, the Lord's ruling of 2026-08-25: a tick that closed the
  // gap itself is an announcement, not an alarm, and no longer pages. This
  // test previously asserted the opposite (`sent.length === 1` with a
  // "This tick spawned ..." body); that assertion encoded the old contract,
  // not a property worth keeping.
  //
  // Both halves of what it was really protecting survive below: the ordering
  // guarantee here, and the notice's truthfulness in the test that follows,
  // which renders the same success case directly.
  const { worker, sent, order } = breachingSpawnTick(async () => TREE_OK);

  await worker.runOnce();

  assert.deepEqual(sent, [], `a successful spawn must not page: ${sent[0] ?? ""}`);
  // Ordering is the structural half of the original fix and is unchanged: the
  // page decision is still taken at the tick's exit, after `create-agent` has
  // actually run, so a page that IS sent could have observed the result.
  assert.deepEqual(order, ["cli:spawn-git-tree", "cli:create-agent"]);
});

test("the success notice still tells the truth if anything ever renders it", () => {
  // `shouldPageFloorBreach` suppresses the send; it does not make this body
  // wrong, and a future caller (a digest, an operator query) may still want
  // it. Kept under test so it cannot rot into a false claim unnoticed.
  const notice = buildFloorBreachNotice({
    liveAlphaCount: 1,
    floorMinimum: 2,
    breachDurationMs: 65_000,
    decision: { action: "spawn", candidate: CANDIDATE, floorOverride: true },
    spawnOutcome: { kind: "spawned" },
  });

  assert.match(notice, /This tick spawned/, notice);
  assert.doesNotMatch(notice, /reported no spawn outcome/, notice);
});

test("a spawn decision that reaches the notice with no recorded outcome reports a defect, not a success", () => {
  const notice = buildFloorBreachNotice({
    liveAlphaCount: 0,
    floorMinimum: 2,
    breachDurationMs: 65_000,
    decision: { action: "spawn", candidate: CANDIDATE, floorOverride: true },
    // spawnOutcome deliberately omitted: a caller that forgot to thread one.
  });

  assert.doesNotMatch(notice, /This tick spawned/, notice);
  assert.match(notice, /reported no spawn outcome/);
  assert.match(notice, /treat the Alpha as NOT spawned/);
  assert.match(notice, /Alpha floor breached: 0 live Alpha\(s\) against a floor of 2/);
  assert.match(notice, /1m 5s/);
});
