// Composes the durable delivery-evidence record with a narrow git check: has
// the recorded commit actually landed on the recorded target branch. This is
// the fact a `reapable` last-message tag alone never proves -- an Alpha can
// end its own turn `reapable` while idle-awaiting a live Shadow, with no
// commit anywhere. Never throws: any unresolvable read (missing record,
// missing repo, missing branch, git failure) resolves to "not proven", the
// fail-closed direction for a check that only ever suppresses a page.
import { DELIVERY_EVIDENCE_DATA } from '../agentdata/delivery-evidence-data.service.ts';
import { repoRoot, readGitStatus } from '../git-lifecycle/git-command.service.ts';

async function commitLandedOnBranch(
  root: string,
  commit: string,
  branch: string,
): Promise<boolean> {
  const result = await readGitStatus(
    ['merge-base', '--is-ancestor', commit, branch],
    root,
  );
  return result.code === 0;
}

/**
 * True only when `name` has a durable `delivery-evidence.json` record AND
 * that record's commit is actually present on its recorded target branch in
 * its recorded repo.
 */
export async function hasProvenDelivery(
  name: string,
  dataDir: string,
): Promise<boolean> {
  const record = await DELIVERY_EVIDENCE_DATA.read(name, dataDir);
  if (record === null) return false;
  try {
    const root = await repoRoot(record.repo);
    return await commitLandedOnBranch(root, record.commit, record.targetBranch);
  } catch {
    return false;
  }
}
