import { evidenceLine } from "../spec-behaviour-evidence-line.mjs";
import { NOT_OURS_REPOSITORIES } from "../spec-behaviour-evidence-fixture.mjs";

export const runsLast = true;

export async function run(context) {
  const changed = NOT_OURS_REPOSITORIES.filter((name) => context.snapshotOf(context.repositories[name]) !== context.before[name]);
  return [
    evidenceLine(
      "E2",
      `git status --porcelain --ignored and a file listing in ${NOT_OURS_REPOSITORIES.join(", ")}, before and after every line`,
      "no not-ours repository gained or changed a file",
      changed.length === 0 ? "unchanged" : `changed: ${changed.join(", ")}`,
      changed.length === 0,
    ),
  ];
}
