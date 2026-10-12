import assert from "node:assert/strict";
import { test } from "node:test";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import {
  STAGER_REUSE_OUTCOMES,
  type StagerReuseOutcome,
} from "../alpha-autoscale/stager-reuse.ts";
import {
  DESIRED_STATES,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";
import {
  createCourtLivenessAlert,
  type ReportCourtLivenessTick,
} from "./court-liveness-alert.ts";
import {
  COURT_LIVENESS_HOSTED_WORKER_NAME,
  CourtLivenessHostedWorker,
} from "./court-liveness.hosted-worker.ts";
import { HostedWorkerRegistrarService } from "./hosted-worker-registrar.service.ts";
import { HOSTED_WORKERS } from "./hosted-worker.types.ts";
import { ThroneBackendModule } from "./throne-backend.module.ts";

const liveRegent: AgentStatusesRosterEntry = {
  name: "Regent",
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
  reportLanded: false,
  role: "Regent",
  focused: false,
};

const deadRegisteredStager: AgentStatusesRosterEntry = {
  name: "stager-ninth",
  lifecycle: AGENT_LIFECYCLE_STATES.DEAD,
  reportLanded: false,
  role: "Stager",
  focused: false,
};

const liveStager: AgentStatusesRosterEntry = {
  ...deadRegisteredStager,
  lifecycle: AGENT_LIFECYCLE_STATES.LIVE,
};

const newlyCreatedStager: AgentStatusesRosterEntry = {
  ...liveStager,
  name: "stager-floor",
};

const rosterReadFailure = "herdr agent list failed: connection refused";

interface FakeCourt {
  desiredState: DesiredState;
  roster: AgentStatusesRosterEntry[];
  rosterReadFailure: string | undefined;
  resurrectionsQueued: number;
  stagersBroughtBack: string[];
  stagersCreated: number;
  readonly messagesToTheLord: string[];
  readonly worker: CourtLivenessHostedWorker;
}

function namedLike(entry: AgentStatusesRosterEntry) {
  return (other: AgentStatusesRosterEntry) => other.name === entry.name;
}

function bringBackTheDeadRegisteredStager(court: FakeCourt): StagerReuseOutcome {
  const dead = court.roster.find(
    (entry) =>
      entry.role === "Stager" &&
      entry.lifecycle === AGENT_LIFECYCLE_STATES.DEAD,
  );
  if (dead === undefined) return { kind: STAGER_REUSE_OUTCOMES.NONE_REUSABLE };
  court.roster = court.roster.map((entry) =>
    namedLike(dead)(entry)
      ? { ...entry, lifecycle: AGENT_LIFECYCLE_STATES.LIVE }
      : entry,
  );
  court.stagersBroughtBack.push(dead.name);
  return {
    kind: STAGER_REUSE_OUTCOMES.REUSED,
    name: dead.name,
    worktree: `/worktrees/${dead.name}`,
  };
}

function alertPostingTo(messages: string[]): ReportCourtLivenessTick {
  return createCourtLivenessAlert({
    postMessage: async (message) => {
      messages.push(message);
    },
    log: () => {},
  });
}

function courtWith(
  roster: readonly AgentStatusesRosterEntry[],
  desiredState: DesiredState = DESIRED_STATES.RUNNING,
  reportTickInsteadOfTheAlert?: ReportCourtLivenessTick,
): FakeCourt {
  const messagesToTheLord: string[] = [];
  const court: FakeCourt = {
    desiredState,
    roster: [...roster],
    rosterReadFailure: undefined,
    resurrectionsQueued: 0,
    stagersBroughtBack: [],
    stagersCreated: 0,
    messagesToTheLord,
    worker: new CourtLivenessHostedWorker({
      readDesiredState: async () => court.desiredState,
      readRoster: async () => {
        if (court.rosterReadFailure !== undefined) {
          throw new Error(court.rosterReadFailure);
        }
        return court.roster;
      },
      readForkedAgentNames: async () => new Set<string>(),
      enqueueRegentResurrection: async () => {
        court.resurrectionsQueued += 1;
      },
      reuseRegisteredStager: async () =>
        bringBackTheDeadRegisteredStager(court),
      ensureLiveStager: async () => {
        court.stagersCreated += 1;
        court.roster = [...court.roster, newlyCreatedStager];
      },
      reportTick:
        reportTickInsteadOfTheAlert ?? alertPostingTo(messagesToTheLord),
    }),
  };
  return court;
}

function effectsOf(court: FakeCourt) {
  return {
    resurrectionsQueued: court.resurrectionsQueued,
    stagersBroughtBack: court.stagersBroughtBack,
    stagersCreated: court.stagersCreated,
  };
}

const nothingDone = {
  resurrectionsQueued: 0,
  stagersBroughtBack: [],
  stagersCreated: 0,
};

const courtAfterABoot = courtWith([deadRegisteredStager]);

test("the first tick after a boot with no Regent asks for a resurrection and raises no Stager", async () => {
  await courtAfterABoot.worker.runOnce();

  assert.deepEqual(effectsOf(courtAfterABoot), {
    ...nothingDone,
    resurrectionsQueued: 1,
  });
});

test("the next tick, with the Regent live, no live Stager and one dead registered Stager, brings that Stager back and creates none", async () => {
  courtAfterABoot.roster = [liveRegent, ...courtAfterABoot.roster];

  await courtAfterABoot.worker.runOnce();

  assert.deepEqual(effectsOf(courtAfterABoot), {
    resurrectionsQueued: 1,
    stagersBroughtBack: [deadRegisteredStager.name],
    stagersCreated: 0,
  });
  assert.deepEqual(courtAfterABoot.roster, [liveRegent, liveStager]);
});

test("a tick with the Regent live and no Stager that can be reused creates one new Stager and reuses none", async () => {
  courtAfterABoot.roster = [liveRegent];

  await courtAfterABoot.worker.runOnce();

  assert.deepEqual(effectsOf(courtAfterABoot), {
    resurrectionsQueued: 1,
    stagersBroughtBack: [deadRegisteredStager.name],
    stagersCreated: 1,
  });
});

test("a tick with a live Regent and a live Stager does nothing", async () => {
  const court = courtWith([liveRegent, liveStager]);

  await court.worker.runOnce();

  assert.deepEqual(effectsOf(court), nothingDone);
  assert.deepEqual(court.messagesToTheLord, []);
});

test("a dismissed court is left down", async () => {
  const court = courtWith([deadRegisteredStager], DESIRED_STATES.DISMISSED);

  await court.worker.runOnce();
  court.roster = [liveRegent, deadRegisteredStager];
  await court.worker.runOnce();

  assert.deepEqual(effectsOf(court), nothingDone);
});

test("a tick that cannot read the roster spawns nothing and reports the failure", async () => {
  const reportedFailures: (string | undefined)[] = [];
  const court = courtWith(
    [deadRegisteredStager],
    DESIRED_STATES.RUNNING,
    async (failure) => {
      reportedFailures.push(failure);
    },
  );
  court.rosterReadFailure = rosterReadFailure;

  await court.worker.runOnce();

  assert.deepEqual(effectsOf(court), nothingDone);
  assert.deepEqual(reportedFailures, [
    `the agent roster could not be read: ${rosterReadFailure}`,
  ]);
});

test("three ticks in a row that cannot read the roster tell the Lord once", async () => {
  const court = courtWith([liveRegent, liveStager]);
  court.rosterReadFailure = rosterReadFailure;

  await court.worker.runOnce();
  await court.worker.runOnce();
  assert.equal(court.messagesToTheLord.length, 0);

  await court.worker.runOnce();
  await court.worker.runOnce();
  assert.equal(court.messagesToTheLord.length, 1);
  assert.ok(court.messagesToTheLord[0].includes(rosterReadFailure));

  court.rosterReadFailure = undefined;
  await court.worker.runOnce();
  court.rosterReadFailure = rosterReadFailure;
  await court.worker.runOnce();
  await court.worker.runOnce();
  assert.equal(court.messagesToTheLord.length, 1);
  assert.deepEqual(effectsOf(court), nothingDone);
});

test("a tick that starts while the previous one is still going does nothing", async () => {
  const court = courtWith([]);

  const firstTick = court.worker.runOnce();
  await court.worker.runOnce();
  await firstTick;

  assert.equal(court.resurrectionsQueued, 1);
});

interface HostedWorkersProvider {
  readonly provide: unknown;
  readonly inject: unknown[];
  readonly useFactory: (...workers: unknown[]) => unknown[];
}

function hostedWorkerClassesOfTheBackend(): unknown[] {
  const providers: Partial<HostedWorkersProvider>[] = Reflect.getMetadata(
    "providers",
    ThroneBackendModule,
  );
  const hostedWorkers = providers.find(
    (provider) => provider.provide === HOSTED_WORKERS,
  ) as HostedWorkersProvider;
  return hostedWorkers.useFactory(...hostedWorkers.inject);
}

test("the backend registers the court liveness worker to run at start and every minute", async () => {
  assert.ok(
    hostedWorkerClassesOfTheBackend().includes(CourtLivenessHostedWorker),
  );
  const court = courtWith([]);
  const ticks: Promise<void>[] = [];
  const runOnce = court.worker.runOnce.bind(court.worker);
  court.worker.runOnce = () => {
    const tick = runOnce();
    ticks.push(tick);
    return tick;
  };
  const scheduler = new SchedulerRegistry();

  new HostedWorkerRegistrarService(
    [court.worker],
    scheduler,
  ).onApplicationBootstrap();
  const job = scheduler.getCronJob(COURT_LIVENESS_HOSTED_WORKER_NAME);
  try {
    assert.equal(court.worker.kind, "cron");
    assert.equal(job.cronTime.source, CronExpression.EVERY_MINUTE);
    assert.equal(ticks.length, 1);
    await Promise.all(ticks);
    assert.equal(court.resurrectionsQueued, 1);
  } finally {
    job.stop();
  }
});
