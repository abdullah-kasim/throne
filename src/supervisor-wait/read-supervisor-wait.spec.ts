import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ACCEPTANCE_DATA, type AcceptanceMethod } from "../agentdata/acceptance-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";
import { readSupervisorWait, SUPERVISOR_WAIT_STEPS } from "./read-supervisor-wait.ts";

const ALPHA = "alpha-scratch-01";
const SHADOW = "shadow-scratch-01-slice";
const REPORT_TIME = new Date("2026-11-11T10:00:00.000Z");
const ACCEPTED_AT = "2026-11-11T10:05:00.000Z";
const GO_AHEAD_AT = "2026-11-11T10:05:02.000Z";
const CAMPAIGN_KINDS: readonly AcceptanceMethod[] = ["merge", "verdict"];

function paneEndingWith(message: string): string {
  return ["⏺ Slice merged and accepted.", "", `  ${message}`, "", "✻ Crunched for 3s", ""].join("\n");
}

async function withLedger(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "supervisor-wait-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function writeShadow(dataDir: string, options: { report: boolean }): Promise<void> {
  const dir = path.join(dataDir, SHADOW);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "identity.md"),
    `# ${SHADOW}\n\n- **Role:** Shadow\n- **Supervisor (routine):** ${ALPHA}\n`,
  );
  if (options.report) {
    const report = path.join(dir, "REPORT.md");
    await writeFile(report, "DONE\n");
    await utimes(report, REPORT_TIME, REPORT_TIME);
  }
}

for (const how of CAMPAIGN_KINDS) {
  test(`a ${how} Shadow that reported DONE and was not yet accepted is waiting on its supervisor`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadow(dataDir, { report: true });
      const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
      assert.deepEqual(wait, {
        waiting: true,
        step: SUPERVISOR_WAIT_STEPS.DONE_AWAITING_ACCEPTANCE,
        supervisor: ALPHA,
        since: REPORT_TIME,
      });
    });
  });

  test(`a ${how} Shadow accepted with no go-ahead recorded is waiting for the go-ahead`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadow(dataDir, { report: true });
      await ACCEPTANCE_DATA.write(SHADOW, { acceptedAt: ACCEPTED_AT, by: ALPHA, how }, dataDir);
      const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
      assert.deepEqual(wait, {
        waiting: true,
        step: SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD,
        supervisor: ALPHA,
        since: new Date(ACCEPTED_AT),
      });
    });
  });

  test(`a ${how} Shadow whose go-ahead failed to send is still waiting for the go-ahead`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadow(dataDir, { report: true });
      await ACCEPTANCE_DATA.write(
        SHADOW,
        {
          acceptedAt: ACCEPTED_AT,
          by: ALPHA,
          how,
          goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "failed", error: "pane gone" },
        },
        dataDir,
      );
      const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
      assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD);
    });
  });

  test(`a ${how} Shadow accepted with the go-ahead recorded is waiting for its own claim`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadow(dataDir, { report: true });
      await ACCEPTANCE_DATA.write(
        SHADOW,
        { acceptedAt: ACCEPTED_AT, by: ALPHA, how, goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "enqueued" } },
        dataDir,
      );
      const wait = await readSupervisorWait({
        agentName: SHADOW,
        dataDir,
        paneText: paneEndingWith(`{"blocked":true} __BLOCKED_BY_${ALPHA}__`),
      });
      assert.deepEqual(wait, {
        waiting: true,
        step: SUPERVISOR_WAIT_STEPS.GO_AHEAD_SENT_AWAITING_CLAIM,
        supervisor: ALPHA,
        since: new Date(GO_AHEAD_AT),
      });
    });
  });

  test(`a ${how} Shadow that has claimed is waiting to be reaped`, async () => {
    await withLedger(async (dataDir) => {
      await writeShadow(dataDir, { report: true });
      await ACCEPTANCE_DATA.write(
        SHADOW,
        { acceptedAt: ACCEPTED_AT, by: ALPHA, how, goAhead: { sentAt: GO_AHEAD_AT, sendOutcome: "enqueued" } },
        dataDir,
      );
      const wait = await readSupervisorWait({
        agentName: SHADOW,
        dataDir,
        paneText: paneEndingWith('{"reapable":"completed"}'),
      });
      assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.CLAIMED_AWAITING_REAP);
    });
  });
}

test("a merged Shadow from an older tree with only delivery evidence is waiting for the go-ahead", async () => {
  await withLedger(async (dataDir) => {
    await writeShadow(dataDir, { report: true });
    await DELIVERY_EVIDENCE_DATA.write(
      SHADOW,
      { repo: "/repos/scratch", targetBranch: ALPHA, commit: "abc123" },
      dataDir,
    );
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD);
    assert.equal(wait.waiting && wait.supervisor, ALPHA);
  });
});

test("a merged Shadow that wrote no REPORT is waiting for the go-ahead", async () => {
  await withLedger(async (dataDir) => {
    await writeShadow(dataDir, { report: false });
    await DELIVERY_EVIDENCE_DATA.write(
      SHADOW,
      { repo: "/repos/scratch", targetBranch: ALPHA, commit: "abc123" },
      dataDir,
    );
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting && wait.step, SUPERVISOR_WAIT_STEPS.ACCEPTED_AWAITING_GO_AHEAD);
  });
});

test("an agent with no REPORT is not waiting", async () => {
  await withLedger(async (dataDir) => {
    await writeShadow(dataDir, { report: false });
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting, false);
  });
});

test("unreadable ledger data reads as not waiting", async () => {
  await withLedger(async (dataDir) => {
    await writeShadow(dataDir, { report: true });
    await writeFile(path.join(dataDir, SHADOW, "acceptance.json"), "{not json");
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting, false);
    assert.match(wait.waiting ? "" : wait.reason, /unreadable/);
  });
});

test("an acceptance record with an unreadable time reads as not waiting", async () => {
  await withLedger(async (dataDir) => {
    await writeShadow(dataDir, { report: true });
    await ACCEPTANCE_DATA.write(SHADOW, { acceptedAt: "yesterday-ish", by: ALPHA, how: "verdict" }, dataDir);
    const wait = await readSupervisorWait({ agentName: SHADOW, dataDir });
    assert.equal(wait.waiting, false);
  });
});
