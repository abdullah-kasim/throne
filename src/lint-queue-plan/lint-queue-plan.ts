import path from "node:path";
import { readSpecFolder } from "../feature-map/feature-map.ts";
import { accountLineFailureIn } from "../regent-queue/queue-row-account.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { IN_THE_DATA_HOME, MADE_WITH_THRONE, resolveSpecLocation } from "../spec-location/spec-location.ts";

// Pure structural lint for a launch-ready consolidated plan body — the
// mechanical half of the Stager consolidation checklist (agent_docs/role-stager.md, "The
// Stager", Lord-ordered 2026-08-19). The chain downstream of the Lord runs
// on weaker models, so this lint's REFUSAL TEXT is the real interface: a
// weak-model Stager does literally what the error says and nothing more.
// Every failure therefore names the missing marker, states what belongs
// under it, and shows the shape — the error message is the training.
//
// Deliberately NOT checked here: whether decisions were genuinely closed or
// nouns genuinely verified. That is judgment, it stays the filing Stager's
// duty, and a lint pass is stated as non-evidence of it (same fail-closed
// honesty as the entrance-steering audit's PASS/N-A discipline).

export interface QueuePlanMarkerSpec {
  readonly marker: string;
  readonly whatBelongs: string;
  readonly example: string;
}

/**
 * The five canonical section markers, exact strings, uppercase with a
 * trailing colon. Exactness is the point: a weak model can grep for these;
 * "a rulings-ish paragraph somewhere" it cannot.
 */
export const QUEUE_PLAN_MARKERS: readonly QueuePlanMarkerSpec[] = [
  {
    marker: "INTENT:",
    whatBelongs:
      "one or two sentences on what outcome this objective exists to produce",
    example: "INTENT: proportional drain across two spawn lanes so neither plan flattens.",
  },
  {
    marker: "SCOPE:",
    whatBelongs:
      "exactly what population/areas the work covers and what it explicitly does not",
    example: "SCOPE: Alpha, Shadow, and 99a spawns only; Regent and Stager are never touched.",
  },
  {
    marker: "RULINGS:",
    whatBelongs:
      "every decision the Lord resolved during consolidation, quoted or closely paraphrased, each with its outcome — so no downstream agent re-faces a fork the Lord already closed",
    example: 'RULINGS: one lane dry -> other takes 100% of spawns ("yes, acceptable" — Lord, 2026-08-19).',
  },
  {
    marker: "VERIFIED-NOUNS:",
    whatBelongs:
      "the exact code nouns (model aliases, command names, file paths, preset names) that were grep-verified against the live tree before filing",
    example: "VERIFIED-NOUNS: codex/gpt-5.6-terra, plan-usage-remaining, SonnetLow, config.user.ts.",
  },
  {
    marker: "REUSE:",
    whatBelongs:
      "the existing functions, types and modules in the target tree that this work must build on or extend instead of duplicating, each as path:line and what it already does, or the literal words 'none found' with the grep that proved it",
    example: "REUSE: web/money.ts:12 formatMoney(amount, options) already formats prices; add a discount option, do not add a formatter.",
  },
];

/**
 * Lints a plan body. Returns one teaching-grade failure line per missing
 * marker (empty array = pass). Markers may appear anywhere in the body;
 * matching is exact-substring on the canonical uppercase form.
 */
export function lintQueuePlanBody(body: string): string[] {
  const failures: string[] = [];
  for (const { marker, whatBelongs, example } of QUEUE_PLAN_MARKERS) {
    if (body.includes(marker)) continue;
    failures.push(
      `missing ${marker} section — add a ${marker} marker followed by ${whatBelongs}. Example: ${example}`,
    );
  }
  const accountFailure = accountLineFailureIn(body);
  if (accountFailure !== undefined) failures.push(accountFailure);
  return failures;
}


export const SPEC_ESCAPE_LINE = "SPECS: none applies";
const MINIMUM_ESCAPE_REASON_WORDS = 4;

export type TargetSpec =
  | { readonly state: "checked"; readonly repository: string; readonly specPath: string; readonly ids: ReadonlySet<string> }
  | { readonly state: "not checked" }
  | { readonly state: "unreadable"; readonly line: string };

function escapeLineGivesReason(body: string): boolean {
  return body.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(SPEC_ESCAPE_LINE)) return false;
    const reasonWords = trimmed.slice(SPEC_ESCAPE_LINE.length).split(/\s+/).filter((word) => /\w/.test(word));
    return reasonWords.length >= MINIMUM_ESCAPE_REASON_WORDS;
  });
}

function bodyNamesAnyId(body: string, ids: ReadonlySet<string>): boolean {
  const words = new Set(body.split(/[^\w.-]+/).flatMap((word) => [word, word.replace(/[.-]+$/, "")]));
  return [...ids].some((id) => words.has(id));
}

export function specCitationFailureIn(body: string, spec: TargetSpec): string | undefined {
  if (spec.state !== "checked") return undefined;
  if (bodyNamesAnyId(body, spec.ids) || escapeLineGivesReason(body)) return undefined;
  return (
    `the target repository has a spec at ${spec.specPath}, but this body names none of its sub-feature IDs. ` +
    `Run \`throne spec-location ${spec.repository} --json\`, read the feature map and the spec files of the area this work touches, ` +
    `and cite each under REUSE: as \`<spec file> (<ID>) — what it already covers\`. ` +
    `For work no spec covers, add a line \`${SPEC_ESCAPE_LINE} — <the reason, in a few words>\`.`
  );
}

export async function readTargetSpec(targetRepository: string, dataHome = resolveThroneHome()): Promise<TargetSpec> {
  try {
    const location = await resolveSpecLocation(targetRepository, dataHome);
    if (location.spec.state !== MADE_WITH_THRONE && location.spec.state !== IN_THE_DATA_HOME) return { state: "not checked" };
    if (location.spec.path === null) return { state: "not checked" };
    const specPath = path.resolve(location.repository, location.spec.path);
    const ids = new Set((await readSpecFolder(specPath)).flatMap((spec) => spec.subFeatureIds));
    if (ids.size === 0) return { state: "unreadable", line: `the spec at ${specPath} declares no sub-feature IDs, so the spec citation check was skipped.` };
    return { state: "checked", repository: location.repository, specPath, ids };
  } catch (error) {
    return {
      state: "unreadable",
      line: `the spec of ${targetRepository} could not be read (${error instanceof Error ? error.message : String(error)}), so the spec citation check was skipped.`,
    };
  }
}

export async function addToQueueRefusesUncitedBody(body: string, targetRepository: string): Promise<boolean> {
  const spec = await readTargetSpec(targetRepository);
  if (spec.state === "unreadable") process.stderr.write(`add-to-queue: ${spec.line}\n`);
  const failure = specCitationFailureIn(body, spec);
  if (failure !== undefined) process.stderr.write(`add-to-queue: ${failure} Nothing was added to the queue.\n`);
  return failure !== undefined;
}
