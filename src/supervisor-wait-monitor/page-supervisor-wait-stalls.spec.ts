import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ACCEPTANCE_DATA,
  type AcceptanceMethod,
  type GoAheadRecord,
} from "../agentdata/acceptance-data.service.ts";
import type { AgentStatusesRosterEntry } from "../agent-statuses/agent-statuses.types.ts";
import type { HerdrAgent, KeepGoingDependencies } from "../keep-going/keep-going-context.ts";
import { DESIRED_STATES, UNTHROTTLED_EVALUATION } from "../keep-going/keep-going-context.ts";
import { tendRegent } from "../keep-going/keep-going-regent-tending.ts";
import { classifyStalls } from "../keep-going/keep-going-stalls.ts";
import { recordClaimSeen } from "../supervisor-wait/claim-seen.ts";
import { SUPERVISOR_WAIT_STEPS } from "../supervisor-wait/read-supervisor-wait.ts";
import {
  ALPHA_PAGES_BEFORE_REGENT,
  pageSupervisorWaitStalls,
  SUPERVISOR_WAIT_PAGE_WINDOW_MS,
  type SupervisorWaitPage,
} from "./page-supervisor-wait-stalls.ts";

const ALPHA = "alpha-scratch-01";
const SHADOW = "shadow-scratch-01-slice";
const REGENT = "Regent";
const REPORT_TIME = new Date("2026-11-11T10:00:00.000Z");
const ACCEPTED_AT = "2026-11-11T10:05:00.000Z";
const GO_AHEAD_AT = "2026-11-11T10:05:02.000Z";
const FIRST_TICK = new Date("2026-11-11T11:00:00.000Z");
const CAMPAIGN_KINDS: readonly AcceptanceMethod[] = ["merge", "verdict"];
const CLAIMED_PANE = ['⏺ Merged; you may publish your reapability claim.', "", '  {"reapable":"completed"}', ""].join("\n");

interface Court {
  readonly dataDir: string;
  readonly ledgerPath: string;
}

async function withCourt(run: (court: Court) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "supervisor-wait-monitor-"));
  try {
    await run({ dataDir: path.join(root, "data"), ledgerPath: path.join(root, "ledger.jsonl") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFinishedShadow(
  court: Court,
  acceptance?: { how: AcceptanceMethod; goAhead?: GoAheadRecord },
): Promise<void> {
  const dir = path.join(court.dataDir, SHADOW);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "identity.md"),
    `# ${SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
  );
  const report = path.join(dir, "REPORT.md");
  await writeFile(report, "DONE\n");
  await utimes(report, REPORT_TIME, REPORT_TIME);
  if (acceptance !== undefined) {
    await ACCEPTANCE_DATA.write(
      SHADOW,
      { acceptedAt: ACCEPTED_AT, by: ALPHA, how: acceptance.how, goAhead: acceptance.goAhead },
      court.dataDir,
    );
  }
}

function roster(alphaStatus: "idle" | "working"): AgentStatusesRosterEntry[] {
  return [
    { name: ALPHA, role: "Alpha", lifecycle: "live", liveStatus: alphaStatus, reportLanded: false, focused: false },
    { name: SHADOW, role: "Shadow", lifecycle: "live", liveStatus: "idle", reportLanded: true, focused: false },
  ];
}

async function tick(
  court: Court,
  options: { now: Date; alphaStatus?: "idle" | "working"; paneText?: string },
): Promise<SupervisorWaitPage[]> {
  const delivered: SupervisorWaitPage[] = [];
  await pageSupervisorWaitStalls({
    roster: roster(options.alphaStatus ?? "idle"),
    now: options.now,
    regentName: REGENT,
    readPaneText: async () => options.paneText ?? "",
    page: async (page) => {
      delivered.push(page);
    },
    dataDir: court.dataDir,
    ledgerPath: court.ledgerPath,
  });
  return delivered;
}

function tickAfter(windows: number): Date {
  return new Date(FIRST_TICK.getTime() + windows * SUPERVISOR_WAIT_PAGE_WINDOW_MS);
}

test("an Alpha idle with a finished child is still reported to the Regent heartbeat as a completed child", () => {
  const signatures = classifyStalls({
    roster: roster("idle"),
    supervisors: new Map([[SHADOW, ALPHA]]),
    staleAlphas: new Set(),
  });
  assert.deepEqual(signatures, [{ alpha: ALPHA, child: SHADOW, reason: "completed-child" }]);
});

test("the keep-going tick runs the supervisor-wait monitor and still reports the stalled family to the Regent", async () => {
  let rosterSeen: readonly AgentStatusesRosterEntry[] = [];
  const families: unknown[] = [];
  const deps = {
    findLiveRegent: async () => ({ name: REGENT, agent: "claude", paneId: "w1:p1" }) as unknown as HerdrAgent,
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    resurrectRegent: async () => undefined,
    evaluateThrottle: async () => UNTHROTTLED_EVALUATION,
    evaluateRegentFence: async () => ({ action: "no-op", reason: "kill switch off" }),
    isRegentHeartbeatNudgeEnabled: async () => false,
    resolveHeartbeatRoot: async () => "/nonexistent",
    getRoster: async () => roster("idle"),
    readStallEvidence: async (entries: readonly AgentStatusesRosterEntry[]) => ({
      roster: entries,
      supervisors: new Map([[SHADOW, ALPHA]]),
      staleAlphas: new Set<string>(),
    }),
    pageSupervisorWaits: async (entries: readonly AgentStatusesRosterEntry[]) => {
      rosterSeen = entries;
      return 1;
    },
    now: () => FIRST_TICK,
    stdout: () => undefined,
    stderr: () => undefined,
  } as unknown as KeepGoingDependencies;
  await tendRegent(deps, async (_regent, _deps, _band, recovery) => {
    families.push(...(recovery ?? []));
  });
  assert.equal(rosterSeen.length, 2);
  assert.equal(families.length, 1);
});

for (const how of CAMPAIGN_KINDS) {
  test(`an Alpha idle with a finished ${how} child not yet accepted is paged and the Regent hears past the limit`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court);
      const pagesPerTick: SupervisorWaitPage[][] = [];
      for (let window = 0; window <= ALPHA_PAGES_BEFORE_REGENT + 1; window += 1) {
        pagesPerTick.push(await tick(court, { now: tickAfter(window) }));
      }
      for (const pages of pagesPerTick) {
        assert.equal(pages[0]?.recipient, ALPHA);
        assert.match(pages[0]!.text, new RegExp(`merge or accept ${SHADOW}`));
      }
      assert.deepEqual(
        pagesPerTick.map((pages) => pages.filter((page) => page.recipient === REGENT).length),
        [0, 0, 1, 0],
      );
      assert.match(pagesPerTick[2]![1]!.text, new RegExp(`${ALPHA} needs to merge or accept ${SHADOW}`));
    });
  });

  test(`a working Alpha with a finished ${how} child not yet accepted is not paged`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court);
      assert.deepEqual(await tick(court, { now: FIRST_TICK, alphaStatus: "working" }), []);
    });
  });

  test(`a ${how === "merge" ? "merged" : "verdict-accepted"} Shadow with no go-ahead recorded makes its Alpha be told to send it`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, { how });
      const pages = await tick(court, { now: FIRST_TICK, alphaStatus: "working" });
      assert.deepEqual(
        pages.map((page) => [page.recipient, page.step]),
        [[ALPHA, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD]],
      );
      assert.match(pages[0]!.text, new RegExp(`send ${SHADOW} its go-ahead`));
      assert.deepEqual(await tick(court, { now: FIRST_TICK }), []);
    });
  });

  test(`a failed go-ahead send to a ${how} Shadow is still caught`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, {
        how,
        goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "failed", error: "queue refused" },
      });
      const pages = await tick(court, { now: FIRST_TICK });
      assert.deepEqual(
        pages.map((page) => [page.recipient, page.step]),
        [[ALPHA, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD]],
      );
    });
  });

  test(`a ${how} Shadow told by hand after a failed go-ahead and since claimed makes the Alpha be told to reap it`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, {
        how,
        goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "failed", error: "queue refused" },
      });
      await recordClaimSeen(SHADOW, court.dataDir, new Date(GO_AHEAD_AT));
      const pages = await tick(court, { now: FIRST_TICK, paneText: CLAIMED_PANE });
      assert.deepEqual(
        pages.map((page) => [page.recipient, page.step]),
        [[ALPHA, SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP]],
      );
    });
  });

  test(`a claim left unreaped by a ${how} Shadow makes the Alpha be told to reap it`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, {
        how,
        goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "enqueued", messageId: "1" },
      });
      await recordClaimSeen(SHADOW, court.dataDir, new Date(GO_AHEAD_AT));
      const pages = await tick(court, { now: FIRST_TICK, paneText: CLAIMED_PANE });
      assert.deepEqual(
        pages.map((page) => [page.recipient, page.step]),
        [[ALPHA, SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP]],
      );
      assert.match(pages[0]!.text, new RegExp(`reap ${SHADOW}`));
    });
  });

  test(`a ${how} Shadow given its go-ahead and not yet claimed is left to the claim monitor`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, {
        how,
        goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "enqueued", messageId: "1" },
      });
      assert.deepEqual(await tick(court, { now: FIRST_TICK }), []);
    });
  });
}

async function writeUnreportedShadow(court: Court, sentTo: string | undefined): Promise<void> {
  const dir = path.join(court.dataDir, SHADOW);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "identity.md"),
    `# ${SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
  );
  if (sentTo !== undefined) {
    await writeFile(
      path.join(dir, "sent-messages.jsonl"),
      `${JSON.stringify({ timestamp: REPORT_TIME.toISOString(), recipient: sentTo, id: "9", transport: "sqlite" })}\n`,
    );
  }
}

function paneBlockedOn(name: string): string {
  return ["⏺ DONE reported.", "", `  {"blocked":true} __BLOCKED_BY_${name}__`, ""].join("\n");
}

for (const kind of ["merging", "verdict-only"]) {
  test(`an idle Alpha whose ${kind} Shadow reported DONE without a REPORT.md is told to merge or accept it`, async () => {
    await withCourt(async (court) => {
      await writeUnreportedShadow(court, ALPHA);
      const pages = await tick(court, { now: FIRST_TICK, paneText: paneBlockedOn(ALPHA) });
      assert.deepEqual(
        pages.map((page) => [page.recipient, page.step]),
        [[ALPHA, SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE]],
      );
    });
  });

  test(`an Alpha that never accepts its finished ${kind} Shadow still reaches the Regent past the limit`, async () => {
    await withCourt(async (court) => {
      await writeUnreportedShadow(court, ALPHA);
      const paneText = paneBlockedOn(ALPHA);
      const recipients: string[][] = [];
      for (let window = 0; window <= ALPHA_PAGES_BEFORE_REGENT; window += 1) {
        recipients.push((await tick(court, { now: tickAfter(window), paneText })).map((page) => page.recipient));
      }
      assert.deepEqual(recipients.at(-1), [ALPHA, REGENT]);
      assert.deepEqual(recipients.slice(0, -1).flat(), Array(ALPHA_PAGES_BEFORE_REGENT).fill(ALPHA));
    });
  });

  test(`a ${kind} Shadow blocked on its Alpha that never messaged it is not taken as finished`, async () => {
    await withCourt(async (court) => {
      await writeUnreportedShadow(court, undefined);
      assert.deepEqual(await tick(court, { now: FIRST_TICK, paneText: paneBlockedOn(ALPHA) }), []);
    });
  });

  test(`a ${kind} Shadow blocked on someone other than its Alpha is not taken as finished`, async () => {
    await withCourt(async (court) => {
      await writeUnreportedShadow(court, ALPHA);
      assert.deepEqual(await tick(court, { now: FIRST_TICK, paneText: paneBlockedOn("shadow-other") }), []);
    });
  });
}

test("a Shadow that finished moments ago is not paged yet", async () => {
  await withCourt(async (court) => {
    await writeFinishedShadow(court);
    assert.deepEqual(await tick(court, { now: new Date(REPORT_TIME.getTime() + 60_000) }), []);
  });
});

for (const how of CAMPAIGN_KINDS) {
  test(`a claimed ${how} Shadow's wait is counted from its claim`, async () => {
    await withCourt(async (court) => {
      await writeFinishedShadow(court, {
        how,
        goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "enqueued", messageId: "1" },
      });
      const claimFirstSeen = FIRST_TICK;
      const atClaim = await tick(court, { now: claimFirstSeen, paneText: CLAIMED_PANE });
      const pastGrace = await tick(court, {
        now: new Date(claimFirstSeen.getTime() + 11 * 60_000),
        paneText: CLAIMED_PANE,
      });
      assert.deepEqual(atClaim, []);
      assert.deepEqual(
        pastGrace.map((page) => page.key),
        [
          `supervisor-wait:${SHADOW}:${SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP}:${claimFirstSeen.toISOString()}:alpha:` +
            `${Math.floor((claimFirstSeen.getTime() + 11 * 60_000) / SUPERVISOR_WAIT_PAGE_WINDOW_MS)}`,
        ],
      );
    });
  });
}

const PROOF_RUN3_DONE_AT = "2026-11-11T10:36:47.558Z";
const PROOF_RUN3_ALPHA_PAGES = ["2026-11-11T11:01:11.491Z", "2026-11-11T11:30:48.997Z"];

for (const kind of ["merging", "verdict-only"]) {
  test(`an Alpha that ignores two pages about its finished ${kind} Shadow brings the Regent in`, async () => {
    await withCourt(async (court) => {
      const dir = path.join(court.dataDir, SHADOW);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "identity.md"),
        `# ${SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
      );
      await writeFile(
        path.join(dir, "sent-messages.jsonl"),
        `${JSON.stringify({ timestamp: PROOF_RUN3_DONE_AT, recipient: ALPHA, id: "25044", transport: "sqlite" })}\n`,
      );
      const paneText = ["⏺ DONE run3.", "", `  {"blocked":true} __BLOCKED_BY_${ALPHA}__`, ""].join("\n");
      const secondPageAt = Date.parse(PROOF_RUN3_ALPHA_PAGES[1]!);
      const alphaPageTimes: string[] = [];
      let regentPagedAt: number | undefined;
      for (const at of PROOF_RUN3_ALPHA_PAGES) {
        for (const page of await tick(court, { now: new Date(at), paneText })) {
          if (page.recipient === ALPHA) alphaPageTimes.push(at);
        }
      }
      for (let minute = 1; minute <= 30 && regentPagedAt === undefined; minute += 1) {
        const now = secondPageAt + minute * 60_000;
        const pages = await tick(court, { now: new Date(now), paneText });
        if (pages.some((page) => page.recipient === REGENT)) regentPagedAt = now;
      }
      assert.deepEqual(alphaPageTimes, PROOF_RUN3_ALPHA_PAGES);
      assert.ok(regentPagedAt !== undefined && regentPagedAt - secondPageAt <= SUPERVISOR_WAIT_PAGE_WINDOW_MS);
    });
  });
}
