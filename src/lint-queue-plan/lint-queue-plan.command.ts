// `lint-queue-plan` — gate for the Stager consolidation checklist
// (AGENTS.md, "The Stager"): before filing a queue objective and notifying
// as launch-ready, the filing Stager runs this against the objective code.
// It reads the queue item's body from the SQLite store and checks the four
// canonical section markers (see lint-queue-plan.ts, which owns the marker
// list and the teaching-grade failure text). Read-only against the store;
// judgment (decisions genuinely closed, nouns genuinely verified) is
// explicitly out of scope and a pass says so.

import { readFileSync } from "node:fs";
import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { findQueueItemByObjectiveCode } from "../regent-queue/regent-queue-lifecycle.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { lintQueuePlanBody } from "./lint-queue-plan.ts";

const USAGE =
  "Usage: ./bin/throne-cli lint-queue-plan --objective-code <code> | --body-file <path>\n";

const PASS_DISCLAIMER =
  "structure ok: all four markers present (INTENT:, SCOPE:, RULINGS:, VERIFIED-NOUNS:). " +
  "This proves structure only — it is NOT evidence that decisions were genuinely closed " +
  "with the Lord or that nouns were genuinely grep-verified; that judgment remains the " +
  "filing Stager's duty.\n";

export interface LintQueuePlanDependencies {
  readBodyByObjectiveCode: (objectiveCode: string) => string | undefined;
  readBodyFile: (path: string) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const PRODUCTION_DEPENDENCIES: LintQueuePlanDependencies = {
  readBodyByObjectiveCode: (objectiveCode) =>
    findQueueItemByObjectiveCode(openRegentQueueStore(), objectiveCode)?.body,
  readBodyFile: (path) => readFileSync(path, "utf8"),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function entranceRefusal(reason: string): string {
  return `${USAGE}${renderEntranceRefusal({
    reason,
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n`;
}

export function runLintQueuePlan(
  passedParams: string[],
  dependencies: LintQueuePlanDependencies = PRODUCTION_DEPENDENCIES,
): number {
  let body: string | undefined;
  let subject: string;
  if (passedParams[0] === "--objective-code" && passedParams.length === 2 && passedParams[1]) {
    subject = `queue item "${passedParams[1]}"`;
    body = dependencies.readBodyByObjectiveCode(passedParams[1]);
    if (body === undefined) {
      dependencies.writeStderr(
        `lint-queue-plan: no queue item found with objective code "${passedParams[1]}".\n`,
      );
      return 1;
    }
  } else if (passedParams[0] === "--body-file" && passedParams.length === 2 && passedParams[1]) {
    subject = `body file ${passedParams[1]}`;
    try {
      body = dependencies.readBodyFile(passedParams[1]);
    } catch (error) {
      dependencies.writeStderr(
        `lint-queue-plan: cannot read ${passedParams[1]}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  } else {
    dependencies.writeStderr(
      entranceRefusal(
        "lint-queue-plan entrance validation requires exactly one subject: --objective-code <code> or --body-file <path>.",
      ),
    );
    return 1;
  }

  const failures = lintQueuePlanBody(body);
  if (failures.length > 0) {
    dependencies.writeStderr(
      `lint-queue-plan: ${subject} is not launch-ready (${failures.length} missing section${failures.length === 1 ? "" : "s"}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
    );
    return 1;
  }
  dependencies.writeStdout(`lint-queue-plan: ${subject} ${PASS_DISCLAIMER}`);
  return 0;
}

@Command({
  name: "lint-queue-plan",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class LintQueuePlanCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = runLintQueuePlan(passedParams);
  }
}
