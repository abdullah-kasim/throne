import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import type { RunGit } from './campaign-evidence-git.ts';

export class EmptyRangeRefusal extends Error {
  constructor(
    readonly base: string,
    readonly head: string,
  ) {
    super(`empty comparison range ${base}..${head}`);
  }
}

export function renderEmptyRangeRefusal(base: string, head: string): string {
  return renderEntranceRefusal({
    reason:
      `campaign-evidence: the resolved comparison range ${base}..${head} contains zero commits, ` +
      'so every section would be computed over an empty diff and report a false clean verdict. ' +
      'Likely cause: a campaign under construction should target its Alpha branch with --head ' +
      '<branch>, not main, since base..main is empty by construction until main absorbs the ' +
      'campaign. See agent_docs/MEMORY/VACUOUS_VERIFICATION_PASSES.md (rule 2: guard the range, not ' +
      'the flag combination that produced it).',
    bypass: undefined,
    supervisorRoute: 'Escalate to the Regent.',
  });
}

/**
 * Refuses when the resolved base..head range contains zero commits. Reads
 * only the resolved commit values — never which flag combination produced
 * them — so it catches every route to an empty range with one mechanism.
 */
export async function requireNonEmptyRange(
  repo: string,
  base: string,
  head: string,
  runGit: RunGit,
): Promise<void> {
  const result = await runGit(repo, ['rev-list', '--count', `${base}..${head}`]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (result.code !== 0 || Number.isNaN(count)) {
    throw new Error(
      `could not compute commit range "${base}..${head}": ${result.stderr.trim() || 'rev-list failed'}`,
    );
  }
  if (count === 0) {
    throw new EmptyRangeRefusal(base, head);
  }
}

/**
 * Writes a loud, non-blocking stderr note when base and target resolve to
 * the same commit. This is a separate signal from range emptiness: a
 * campaign under construction legitimately has base === target (--head
 * <Alpha-branch> --target main before main absorbs the campaign) while the
 * range itself is non-empty, so this never changes the exit code.
 */
export function flagBaseEqualsTarget(
  base: string,
  target: string,
  writeStderr: (text: string) => void,
): void {
  if (base === target) {
    writeStderr(
      `campaign-evidence: NOTE base and target both resolve to ${base}. This is the correct shape ` +
        'for a campaign under construction (--head <Alpha-branch> --target main before main has ' +
        'absorbed the campaign); it is not a refusal.\n',
    );
  }
}
