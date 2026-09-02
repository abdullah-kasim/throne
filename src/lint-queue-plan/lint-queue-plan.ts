// Pure structural lint for a launch-ready consolidated plan body — the
// mechanical half of the Stager consolidation checklist (AGENTS.md, "The
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
 * The four canonical section markers, exact strings, uppercase with a
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
  return failures;
}
