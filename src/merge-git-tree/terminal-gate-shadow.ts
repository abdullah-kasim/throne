/**
 * Is this agent name a VERDICT-SHAPED terminal-gate Shadow — one whose own
 * branch may legitimately carry no diff at merge time?
 *
 * The live terminal chain is THREE gates, since the Lord's order of 2026-08-25:
 * `99a` validates that what is being delivered does what the Lord literally
 * asked for, `99b` runs the bundle's tests and lint and FIXES what fails, then
 * `99c` merges the latest target and delivers. Both `99a` and `99b` are
 * verdict-shaped here — `99a` because it grades and never writes product code,
 * `99b` not because it never touches code (it commits its own repairs) but
 * because a candidate that was already green gives it nothing to commit, and
 * that no-op is the correct shape rather than a lost commit. Pre-renumber slice
 * ids stay verdict-shaped so historical bundles keep their authored meaning.
 *
 * Delivery gates (`99c` now; `99b` under the two-gate chain, `99e` under the
 * five-gate one) are DELIBERATELY EXCLUDED from this set — see
 * `isTerminalDeliveryShadowName` below and `isDeliveryGateNoopExempt` in
 * `merge-git-tree-runtime.ts`. A delivery gate's content lands via the ALPHA
 * branch, not its own, so its no-op is correct only once the campaign's touched
 * paths are independently proven to retain their delivered blobs (via
 * `checkDeliveryVerdict`) — never on the Shadow's own say-so, and never waived
 * when that check fails.
 *
 * The canonical handle is `shadow-<objective-code>-<slice-id>` (see
 * `canonicalShadowNameFromAlpha` in `../shared-policy/objective-contract.ts`),
 * and `<slice-id>` is always the todo file's own basename verbatim, so a
 * gate's slice-id always starts with its literal `99a`/`99b`/`99c` token and
 * carries its role word after it, which is what classification reads.
 *
 * Why this matters to `merge-git-tree`: a terminal-gate Shadow writes its own
 * per-Shadow `REPORT.md` (evidence-gate durable proof) BEFORE reporting DONE —
 * i.e. before `merge-git-tree` is ever invoked for it. `REPORT.md` lives in the
 * throne's own gitignored ledger, never inside the merged tree, so a clean
 * verdict produces a real `REPORT.md` and a genuinely empty merge diff at
 * the same time, by design. `listCompletedAgents` (what `merge-git-tree`'s
 * `isCompletedAgent` reads) is defined purely as "`REPORT.md` exists" — so this
 * expected, designed shape reads identically to the WLS defect signature
 * (`completed && noop`).
 *
 * **This name check is the RETAINED FALLBACK, not the primary discriminator.**
 * `merge-git-tree`'s noop-exemption decision (`isNoopExemptFromWlsRefusal` in
 * `merge-git-tree-runtime.ts`) checks PRIMARILY the agent's own `spawn.json`
 * `deliverable_shape === "verdict-only"` field — a property-keyed signal
 * declared once, at spawn time, by whoever assigns the work (`create-agent`).
 * Under the two-gate chain neither terminal gate is spawned with that flag, so
 * for `99a` and `99b` this name pattern is the operative half of the OR.
 *
 * **The primary signal is not tamper-proof or permission-enforced.** Every
 * agent runs as the same OS user with ordinary read/write access to its own
 * `~/.throne/data/<name>/spawn.json`, which is not git-tracked or otherwise
 * append-only. A governed agent CAN edit it to set the field after spawn; doing
 * so is deliberate falsification of the agent's own ledger record, the same
 * category of trust violation as hand-editing a `REPORT.md` to fake evidence
 * never produced — not a normal workflow operation, and never described as
 * enforced.
 *
 * ## Retirement criteria
 *
 * Delete this name-keyed fallback (and the `isTerminalGateShadowName` OR
 * branch in `isNoopExemptFromWlsRefusal`) once no live or reapable agent's
 * `spawn.json` predates the `deliverable_shape` field — concretely: every
 * agent's `spawn.json` under `~/.throne/data` either already carries
 * `deliverable_shape`, or was spawned before this change landed and has
 * since been reaped (so it no longer exists to fall back for). Until then,
 * the OR is the union of both permissive paths, so anything the name
 * pattern alone would have wrongly exempted, it still wrongly exempts — the
 * fallback is a time-bounded migration aid, not a permanent second
 * discriminator.
 */
const TERMINAL_GATE_SLICE_ID_PATTERN =
  /^shadow-[a-z0-9]+-(99[abcde])(?:[-_](.*))?$/;

type TerminalGateRole = "absorb" | "verdict" | "delivery";

/** The delivery gate's role word. Classification keys on THIS, not on the bare
 *  `99x` letter, and the reason is the 2026-08-25 renumber: inserting the
 *  conformance gate at `99a` moved verify to `99b` and delivery to `99c`, so
 *  the bare letter `99b` now means "tests and lint" for a new bundle and
 *  "delivery" for a two-gate bundle authored before the renumber. The letter is
 *  therefore ambiguous across bundle generations and the role word is not:
 *  every delivery gate has been named `*_deliver_*` in every chain the throne
 *  has ever shipped (five-gate `99e_deliver`, two-gate `99b_deliver`,
 *  three-gate `99c_deliver`). Misclassifying a live verify gate as a delivery
 *  gate would subject a legitimately empty verify diff to the delivery
 *  precondition and refuse it, so this is not cosmetic. */
const DELIVERY_ROLE_WORD = "deliver";

/** Bare-letter fallback for names carrying no role word at all
 *  (`shadow-xyz-99e`). Pre-renumber generations only: a new bundle's slice id
 *  always carries its verb, so the fallback never decides a current name. */
const LEGACY_BARE_DELIVERY_SLICE_IDS: readonly string[] = ["99b", "99e"];

export function terminalGateRoleFromShadowName(
  name: string,
): TerminalGateRole | undefined {
  const match = TERMINAL_GATE_SLICE_ID_PATTERN.exec(name);
  const sliceId = match?.[1];
  if (sliceId === undefined) return undefined;
  const roleWords = (match?.[2] ?? "").split(/[-_]/).filter(Boolean);
  if (roleWords.length > 0) {
    return roleWords.includes(DELIVERY_ROLE_WORD) ? "delivery" : "verdict";
  }
  return LEGACY_BARE_DELIVERY_SLICE_IDS.includes(sliceId)
    ? "delivery"
    : "verdict";
}

export function isTerminalGateShadowName(name: string): boolean {
  return terminalGateRoleFromShadowName(name) === "verdict";
}

/**
 * Is this agent name a delivery-gate Shadow (`99c`, or legacy `99b`/`99e`) — the sole terminal
 * worker whose PASS certifies "the work exists on the recorded target
 * branch," not a property of the code? Deliberately its own pattern, not
 * folded into `VERDICT_GATE_SLICE_ID_PATTERN` above: a delivery gate legitimately
 * produces commits (see the doc comment above `isTerminalGateShadowName`),
 * so it is excluded from the no-diff verdict-gate set, but it still needs a
 * name-shaped discriminator for `agent-evidence-gate.ts` to hang the
 * machine-checked path-wise delivery precondition on (see `HDL_DELIVERY_PRECONDITION`
 * campaign — a shadow-pln-99e reported `**Delivery outcome:** PASS` in
 * prose having only called `absorb-git-tree`, never `merge-git-tree`, and
 * nothing forced the path-wise delivery proof at verdict time).
 */
export function isTerminalDeliveryShadowName(name: string): boolean {
  return terminalGateRoleFromShadowName(name) === "delivery";
}

export function isTerminalAbsorbOrDeliveryShadowName(name: string): boolean {
  const role = terminalGateRoleFromShadowName(name);
  return role === "absorb" || role === "delivery";
}
