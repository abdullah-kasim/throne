import { readMarkdownSection } from './skill-contract-test-helpers.ts';

export const ALTITUDE_HEADING =
  '## Planning altitude — state semantics, leave mechanics to execution';

export type AltitudeRuleId =
  | 'PRINCIPLE_REFERENCE'
  | 'REQUIRED_SEMANTIC_CONTENT'
  | 'FORBIDDEN_PLANNER_MECHANICS'
  | 'EXISTING_OR_FIXED_NAME_BOUNDARY'
  | 'SHARED_SEMANTIC_DECISION'
  | 'TRIVIAL_EXPRESSION_BOUNDARY'
  | 'FILE_INVENTORY_OBLIGATION'
  | 'FILE_INVENTORY_GROUPS'
  | 'FILE_INVENTORY_HYPOTHESIS'
  | 'FILE_INVENTORY_GRANULARITY'
  | 'SLICE_TEMPLATE'
  | 'STALE_MECHANICS_GUIDANCE';

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ').trim();
}

/**
 * The planning freedoms `write-todos` must keep: what the planner states, what
 * it must never prescribe, and the suspected file inventory's three groups,
 * granularity, and hypothesis status.
 */
export function checkPlanningAltitude(source: string): AltitudeRuleId[] {
  const failures: AltitudeRuleId[] = [];
  const altitude = normalize(readMarkdownSection(source, ALTITUDE_HEADING)).replace(
    /\*\*/g,
    '',
  );
  const todoTemplate = normalize(source);

  if (
    !/global `claude\/agent_docs\/coding_principles\.md` section “Name the logic before implementing it”/.test(
      altitude,
    ) ||
    !/Apply it by reference here; do not duplicate or paraphrase that principle into a second doctrine/.test(
      altitude,
    )
  ) {
    failures.push('PRINCIPLE_REFERENCE');
  }

  if (
    !/semantic decisions, invariants, reuse obligations, required evidence, and observable outcomes/.test(
      altitude,
    )
  ) {
    failures.push('REQUIRED_SEMANTIC_CONTENT');
  }

  if (
    !/MUST NOT prescribe exact function names, line-by-line algorithms, file-local mechanics, or freeze a speculative call graph/.test(
      altitude,
    ) ||
    /planner (?:may|should|can|must(?! not))[^.]{0,120}(?:invent|prescribe|choose)[^.]{0,120}(?:function names|line-by-line algorithms|file-local mechanics|call graph)/i.test(
      altitude,
    )
  ) {
    failures.push('FORBIDDEN_PLANNER_MECHANICS');
  }

  if (
    !/bind planner inventions, not a symbol demonstrably already present in the target code or an externally fixed name/.test(
      altitude,
    ) ||
    !/public API, CLI flag, on-disk key, or protocol field/.test(altitude)
  ) {
    failures.push('EXISTING_OR_FIXED_NAME_BOUNDARY');
  }

  if (
    !/two or more places in a slice turn on the same domain rule[^.]+share ONE semantic decision/.test(
      altitude,
    ) ||
    !/names that decision in domain language; it never names the function that will implement it/.test(
      altitude,
    )
  ) {
    failures.push('SHARED_SEMANTIC_DECISION');
  }

  if (
    !/Trivial expressions are exempt: arithmetic, string formatting, and an obvious single-use comparison require no plan sentence, named predicate, or extraction obligation/.test(
      altitude,
    )
  ) {
    failures.push('TRIVIAL_EXPRESSION_BOUNDARY');
  }

  if (
    !/Every generated slice \(`01`–`98` and each terminal todo\) also records a high-level suspected file inventory/.test(
      altitude,
    )
  ) {
    failures.push('FILE_INVENTORY_OBLIGATION');
  }

  if (
    !/Files likely needing READ/.test(altitude) ||
    !/Files likely needing CHANGE/.test(altitude) ||
    !/Files likely needing CREATE/.test(altitude) ||
    !/### Files likely needing READ/.test(todoTemplate) ||
    !/### Files likely needing CHANGE/.test(todoTemplate) ||
    !/### Files likely needing CREATE/.test(todoTemplate)
  ) {
    failures.push('FILE_INVENTORY_GROUPS');
  }

  if (
    !/search-starting HYPOTHESIS, explicitly not an execution allowlist/.test(
      altitude,
    ) ||
    !/executor may refine it after recon; an unlisted file is never off-limits/.test(
      altitude,
    ) ||
    !/search-starting HYPOTHESIS at FILE granularity, not an execution allowlist/.test(
      todoTemplate,
    )
  ) {
    failures.push('FILE_INVENTORY_HYPOTHESIS');
  }

  if (
    !/inventory is FILE granularity only: naming a file is not naming a function/.test(
      altitude,
    ) ||
    !/must not prescribe function names, signatures, call graphs, line-by-line algorithms, or code sketches/.test(
      altitude,
    ) ||
    !/List file paths only — never functions, signatures, call graphs, algorithms, or code sketches/.test(
      todoTemplate,
    )
  ) {
    failures.push('FILE_INVENTORY_GRANULARITY');
  }

  if (
    !/## Semantic contract/.test(todoTemplate) ||
    !/Required for every non-trivial coding slice: state the semantic decisions, invariants, reuse obligations, required evidence, and observable outcomes/.test(
      todoTemplate,
    ) ||
    !/declare one shared semantic decision in domain language without choosing its implementing function/.test(
      todoTemplate,
    ) ||
    !/Omit trivial arithmetic, formatting, and obvious single-use comparisons/.test(
      todoTemplate,
    )
  ) {
    failures.push('SLICE_TEMPLATE');
  }

  if (
    /Whatever locks the contract for downstream todos: file layout, API shape/.test(source) ||
    /Include code sketches when they pin a contract/.test(source) ||
    /Wire format, function signatures, file paths, error envelopes/.test(source)
  ) {
    failures.push('STALE_MECHANICS_GUIDANCE');
  }

  return failures;
}
