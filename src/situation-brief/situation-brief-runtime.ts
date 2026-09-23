import {
  openRegentQueueAmendments,
  type RegentQueueAmendments,
} from "../regent-queue/regent-queue-amendments.ts";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type RegentQueueItemRow,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { queueAddressingObjectiveCode } from "../shared-policy/objective-contract.ts";
import {
  runBriefCommand,
  type BriefCommandRunner,
  type BriefSection,
} from "./brief-command-runner.ts";
import { readCitedCommits } from "./cited-commits.ts";
import { readOpenPullRequests } from "./open-pull-requests.ts";
import { readRepositorySituation } from "./repository-situation.ts";
import {
  deliveryBranchOf,
  readSiblingObjectives,
  repositoryOf,
} from "./sibling-objectives.ts";
import {
  composeSituationBrief,
  INFORMATIONAL_SIZE_LIMIT_BYTES,
  SITUATION_BRIEF_HEADING,
} from "./situation-brief-composer.ts";

export const WITHOUT_SIZE_LIMIT = Number.POSITIVE_INFINITY;

export interface SituationBriefDependencies {
  readonly openStore: () => RegentQueueStore;
  readonly openAmendments: () => RegentQueueAmendments;
  readonly runCommand: BriefCommandRunner;
  readonly now: () => number;
}

export const REAL_SITUATION_BRIEF_DEPENDENCIES: SituationBriefDependencies = {
  openStore: openRegentQueueStore,
  openAmendments: openRegentQueueAmendments,
  runCommand: runBriefCommand,
  now: Date.now,
};

async function readRepositorySections(
  row: RegentQueueItemRow,
  dependencies: SituationBriefDependencies,
): Promise<BriefSection[]> {
  const repository = repositoryOf(row);
  const branch = deliveryBranchOf(row);
  if (repository === null || branch === null) {
    return [
      {
        title: "Repository",
        trimmable: false,
        lines: ["This row names no target repository and branch, so only queue context is reported."],
      },
    ];
  }
  const facts = { repository, branch, body: row.body };
  return [
    await readRepositorySituation(dependencies.runCommand, {
      repository,
      branch,
      filedBase: row.launchEligibility?.baseCommit ?? row.baseCommit,
    }),
    await readOpenPullRequests(dependencies.runCommand, facts),
    await readCitedCommits(dependencies.runCommand, facts),
  ];
}

export async function composeSituationBriefForObjective(
  objectiveCode: string,
  dependencies: SituationBriefDependencies = REAL_SITUATION_BRIEF_DEPENDENCIES,
  sizeLimitBytes: number = INFORMATIONAL_SIZE_LIMIT_BYTES,
): Promise<string> {
  const store = dependencies.openStore();
  const amendments = dependencies.openAmendments();
  try {
    const row = findQueueItemByObjectiveCode(store, objectiveCode);
    const composedAt = new Date(dependencies.now()).toISOString();
    if (row === undefined) {
      return `${SITUATION_BRIEF_HEADING}\n\nComposed ${composedAt}: no queue row is named "${objectiveCode}", so there is no situation to report.`;
    }
    const all = store.readAll();
    const rows = all.state === "items" ? all.items : [];
    const repositorySections = await readRepositorySections(row, dependencies);
    return composeSituationBrief({
      objectiveCode,
      composedAt,
      amendments: amendments.readForObjective(objectiveCode),
      sizeLimitBytes,
      sections: [
        repositorySections[0]!,
        readSiblingObjectives(rows, row, dependencies.now()),
        ...repositorySections.slice(1),
      ],
    });
  } finally {
    amendments.close();
    store.close();
  }
}

export const SITUATION_BRIEF_USAGE = "usage: throne situation-brief --objective-code <code>";

export async function run(
  args: string[],
  dependencies: SituationBriefDependencies = REAL_SITUATION_BRIEF_DEPENDENCIES,
  out: (message: string) => void = (message) => void process.stdout.write(message),
  err: (message: string) => void = (message) => void process.stderr.write(message),
): Promise<number> {
  const objectiveCode =
    args.length === 2 && args[0] === "--objective-code" ? queueAddressingObjectiveCode(args[1]!) : undefined;
  if (objectiveCode === undefined) {
    err(
      `situation-brief: expected exactly --objective-code <code>\n${SITUATION_BRIEF_USAGE}\n${renderEntranceRefusal({
        reason: "situation-brief entrance validation refused this invocation.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 1;
  }
  out(`${await composeSituationBriefForObjective(objectiveCode, dependencies, WITHOUT_SIZE_LIMIT)}\n`);
  return 0;
}
