/**
 * Fixed completion section appended to every slice ASSIGNMENT.md body.
 *
 * Rule 6 of execute-todos/SKILL.md requires the Alpha to call
 * `merge-git-tree` unconditionally on every slice — including a
 * zero-diff/finding-only slice — because the no-op merge itself publishes
 * the completion stamp that makes the Shadow reapable. This text is the
 * structural enforcement of that invariant: it is appended by the renderer
 * below, not hand-typed by the Alpha, so no assignment can omit it.
 */
export const SLICE_ASSIGNMENT_COMPLETION_MARKER =
  "## Completion (mandatory)";

export const SLICE_ASSIGNMENT_COMPLETION_SECTION = `${SLICE_ASSIGNMENT_COMPLETION_MARKER}

Whether this slice has a large diff, a tiny diff, or no diff at all: after
your one commit, report DONE to your supervisor via \`send-agent\` and wait;
do not self-merge, do not self-reap. Your supervisor calls
\`node "$THRONE/src/tools.ts" merge-git-tree "$slice_addr"\` — you do not call
it yourself — then sends you a merge-confirmation message. A zero-diff/
finding-only slice is not exempt: the no-op merge itself publishes the
completion stamp that makes you reapable via plain \`complete-agent\`, so
\`merge-git-tree\` is called unconditionally.

Your wait has two ways to end, both finishing the same way:

1. **Primary:** the moment your supervisor's merge-confirmation message
   arrives, publish \`${formatReapabilityClaim("completed")}\` as your latest
   message. No other action is required first.
2. **Fallback, usable without waiting on that message at all — but ONLY
   after you have reported DONE, never before:** a send is not a delivery,
   so if the confirmation is slow or lost you may independently check
   whether the merge already landed by calling \`hasDeliveryCommit\` (
   \`src/git-lifecycle/delivery-commit-proof.ts\`) against your own recorded
   name and target branch. That check greps your branch history for a
   commit titled exactly \`Deliver <your-name>\`, so it stays false until
   your own merge lands and cannot be tripped by a sibling's unrelated
   merge advancing the same branch. The instant it turns true, publish the
   same claim the same way.

Never publish the claim before you have reported DONE and one of the two
signals above is actually true — not speculatively, not merely because time
has passed.
`;

/**
 * Appends the fixed completion section to a slice-specific assignment body.
 * There is no parameter, flag, or branch here that can produce output
 * missing the section — that is the whole point.
 */
export function renderSliceAssignment(body: string): string {
  const trimmedBody = body.replace(/\s+$/, "");
  return `${trimmedBody}\n\n${SLICE_ASSIGNMENT_COMPLETION_SECTION}`;
}
import { formatReapabilityClaim } from "../reap-agent/reapability-claim.ts";
