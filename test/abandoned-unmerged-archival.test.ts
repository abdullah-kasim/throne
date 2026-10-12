import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";

import { git, initRepo } from "./git-repo-test-fixture.ts";
import { REAP_REASON } from "../src/agent-timings/reap-reason.ts";
import { fileExists, LedgerDataService } from "../src/agentdata/ledger-data.service.ts";
import {
  ABANDONED_UNMERGED_TREE_BASE_BASENAME,
  TREE_BASE_DATA,
} from "../src/agentdata/tree-base-data.service.ts";
import { ARCHIVE_ABANDONED_UNMERGED_FLAG, parseReapRequest } from "../src/reap-agent/input.ts";
import { reapAgent } from "../src/reap-agent/lifecycle.ts";
import { resolveQueueReapEvidence } from "../src/reap-agent/queue-reap-writeback.ts";
import { reapDepsWithNothingToTearDown } from "../src/reap-agent/reap-agent-test-fixtures.ts";

const AGENT_NAME = "shadow-archival-01";
const RETIRED_ARCHIVE_FLAG = "--archive-cancelled-unmerged";

interface AbandonedLifecycle {
  readonly ledgerDirectory: string;
  readonly launchLedgerPath: string;
  readonly repository: string;
  readonly branchTip: string;
  readonly treeBaseBytes: Buffer;
}

async function lifecycleWithUnmergedWork(
  context: TestContext,
): Promise<AbandonedLifecycle> {
  const repository = await initRepo("abandoned-unmerged-repo-");
  const dataHome = await mkdtemp(path.join(tmpdir(), "abandoned-unmerged-data-"));
  context.after(() =>
    Promise.all(
      [repository, dataHome].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );
  const spawnCommit = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "-b", AGENT_NAME]);
  await writeFile(path.join(repository, "work.txt"), "unlanded work\n", "utf8");
  await git(repository, ["add", "work.txt"]);
  await git(repository, ["commit", "--no-gpg-sign", "-m", "unlanded work"]);
  const branchTip = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "main"]);
  const ledgerDirectory = path.join(dataHome, "data");
  await TREE_BASE_DATA.write(
    AGENT_NAME,
    {
      name: AGENT_NAME,
      base: "main",
      branch: "main",
      commit: spawnCommit,
      repo: repository,
      notedAt: "2026-10-08T08:00:00.000Z",
    },
    ledgerDirectory,
  );
  return {
    ledgerDirectory,
    launchLedgerPath: path.join(dataHome, "alpha-launch-ledger.jsonl"),
    repository,
    branchTip,
    treeBaseBytes: await readFile(
      path.join(ledgerDirectory, AGENT_NAME, "tree-base.json"),
    ),
  };
}

async function archiveAsAbandoned(
  lifecycle: AbandonedLifecycle,
): Promise<{ exitCode: number; output: string }> {
  const ledger = new LedgerDataService();
  const request = parseReapRequest([
    AGENT_NAME,
    "--reason",
    REAP_REASON.ABANDONED,
    ARCHIVE_ABANDONED_UNMERGED_FLAG,
  ]);
  const writes: string[] = [];
  const stdoutWrite = mock.method(process.stdout, "write", (chunk: string) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    const exitCode = await reapAgent(
      request,
      reapDepsWithNothingToTearDown({
        listAgents: async () => [],
        readTreeBase: (name) => TREE_BASE_DATA.read(name, lifecycle.ledgerDirectory),
        readTreeBaseForAbandonedUnmerged: (name) =>
          TREE_BASE_DATA.readForAbandonedUnmerged(name, lifecycle.ledgerDirectory),
        preserveTreeBaseForAbandonedUnmerged: (name, authority) =>
          TREE_BASE_DATA.preserveForAbandonedUnmerged(
            name,
            authority,
            lifecycle.ledgerDirectory,
          ),
        archiveAgentData: (name) =>
          ledger.archiveAgentData(name, lifecycle.ledgerDirectory),
        resolveQueueReapEvidence: (name, reason) =>
          resolveQueueReapEvidence(name, reason, {
            ledgerBaseDir: lifecycle.ledgerDirectory,
            findDeliveryCommitHash: async () => undefined,
          }),
        launchLedgerPath: lifecycle.launchLedgerPath,
        now: () => "2026-10-08T09:00:00.000Z",
      }),
      new Set(),
    );
    return { exitCode, output: writes.join("") };
  } finally {
    stdoutWrite.mock.restore();
  }
}

function archivedLedgerPath(lifecycle: AbandonedLifecycle, basename: string): string {
  return path.join(lifecycle.ledgerDirectory, ".reaped", AGENT_NAME, basename);
}

test("an unmerged branch can be archived as abandoned while its exact ref is kept", async (context) => {
  const lifecycle = await lifecycleWithUnmergedWork(context);

  const { exitCode } = await archiveAsAbandoned(lifecycle);

  assert.equal(exitCode, 0);
  assert.equal(
    await git(lifecycle.repository, ["rev-parse", `refs/heads/${AGENT_NAME}`]),
    lifecycle.branchTip,
  );
  assert.equal(
    await fileExists(path.join(lifecycle.ledgerDirectory, AGENT_NAME)),
    false,
  );
});

test("archiving an unmerged branch needs the abandoned reason", () => {
  assert.throws(
    () =>
      parseReapRequest([
        AGENT_NAME,
        "--reason",
        REAP_REASON.FORCE,
        ARCHIVE_ABANDONED_UNMERGED_FLAG,
      ]),
    new RegExp(`${ARCHIVE_ABANDONED_UNMERGED_FLAG} requires --reason abandoned`),
  );
  assert.equal(
    parseReapRequest([
      AGENT_NAME,
      "--reason",
      REAP_REASON.ABANDONED,
      ARCHIVE_ABANDONED_UNMERGED_FLAG,
    ]).archiveAbandonedUnmerged,
    true,
  );
});

test("the abandoned reason with the archive flag writes tree-base.abandoned-unmerged.json", async (context) => {
  const lifecycle = await lifecycleWithUnmergedWork(context);

  const { exitCode } = await archiveAsAbandoned(lifecycle);

  assert.equal(exitCode, 0);
  assert.equal(ABANDONED_UNMERGED_TREE_BASE_BASENAME, "tree-base.abandoned-unmerged.json");
  assert.deepEqual(
    await readFile(archivedLedgerPath(lifecycle, ABANDONED_UNMERGED_TREE_BASE_BASENAME)),
    lifecycle.treeBaseBytes,
  );
  assert.equal(
    await fileExists(archivedLedgerPath(lifecycle, "tree-base.json")),
    false,
  );
});

test("the old archive-cancelled-unmerged flag is refused", () => {
  assert.throws(
    () =>
      parseReapRequest([
        AGENT_NAME,
        "--reason",
        REAP_REASON.ABANDONED,
        RETIRED_ARCHIVE_FLAG,
      ]),
    new RegExp(`unknown flag "${RETIRED_ARCHIVE_FLAG}"`),
  );
});

test("an abandoned unmerged archival reports ABANDONED-UNMERGED", async (context) => {
  const lifecycle = await lifecycleWithUnmergedWork(context);

  const { exitCode, output } = await archiveAsAbandoned(lifecycle);

  assert.equal(exitCode, 0);
  assert.match(
    output,
    new RegExp(
      `^ABANDONED-UNMERGED "${AGENT_NAME}": retained refs/heads/${AGENT_NAME} at ${lifecycle.branchTip};`,
      "m",
    ),
  );
});
