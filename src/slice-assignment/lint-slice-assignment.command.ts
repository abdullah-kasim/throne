// Gate for execute-todos/SKILL.md step 4: an Alpha must run this against a
// freshly written ASSIGNMENT.md before spawning the Shadow it targets, so a
// hand-authored assignment that dropped the mandatory completion section
// (see slice-assignment-template.ts) is refused before the Shadow ever reads
// it, instead of surfacing as a missing merge-git-tree call after the fact.

import { readFileSync } from "node:fs";
import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { SLICE_ASSIGNMENT_COMPLETION_MARKER } from "./slice-assignment-template.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const USAGE = "Usage: ./bin/throne-cli lint-slice-assignment <path>\n";

/**
 * Checks whether the assignment file at `path` contains the fixed
 * completion marker. Returns a reason string on failure, `undefined` on
 * success — never throws for a missing marker, only for I/O errors.
 */
export function lintSliceAssignment(path: string): string | undefined {
  const contents = readFileSync(path, "utf8");
  if (!contents.includes(SLICE_ASSIGNMENT_COMPLETION_MARKER)) {
    return `missing mandatory completion section (expected marker ${JSON.stringify(
      SLICE_ASSIGNMENT_COMPLETION_MARKER,
    )}) in ${path}`;
  }
  return undefined;
}

export function runLintSliceAssignment(
  passedParams: string[],
  lint: (path: string) => string | undefined = lintSliceAssignment,
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  writeStdout: (text: string) => void = (text) => process.stdout.write(text),
): number {
  const path = passedParams[0];
  if (!path || passedParams.length > 1) {
    writeStderr(`${USAGE}${renderEntranceRefusal({ reason: "lint-slice-assignment entrance validation requires exactly one assignment path.", bypass: undefined, supervisorRoute: "Ask your supervisor for an allowed alternative invocation." })}\n`);
    return 1;
  }
  const reason = lint(path);
  if (reason !== undefined) {
    writeStderr(`${reason}\n`);
    return 1;
  }
  writeStdout(`ok: completion marker present in ${path}\n`);
  return 0;
}

@Command({
  name: "lint-slice-assignment",
  allowUnknownOptions: false,
  allowExcessArgs: false,
})
export class LintSliceAssignmentCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    process.exitCode = runLintSliceAssignment(passedParams);
  }
}
