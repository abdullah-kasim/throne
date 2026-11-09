import { isMainCheckoutRoot } from '../src/shared-policy/runtime-throne-root.ts';

export const CHECKOUT_KINDS = { PRIVATE: 'private', PUBLIC: 'public', FORK: 'fork' };
export const BRANCH_RELATIONS = { SAME: 'same', BEHIND: 'behind', AHEAD: 'ahead', DIVERGED: 'diverged' };

const ORIGIN_REMOTE = 'origin';
const UPSTREAM_REMOTE = 'upstream';
const PRIVATE_NAME_SUFFIX = '-private';
const GITHUB_REPOSITORY_IN_URL = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/;
const DEFAULT_BRANCH_LINE = /^ref: refs\/heads\/(\S+)\s+HEAD$/m;
const SECONDS_TO_WAIT_FOR_HOST = 10;
const VENDOR_PINS_FILE = 'vendor-pins.json';
const HERDR_CLIENT_FILE = 'src/herdr/herdr-client.ts';
const HERDR_PIN_LINE = /OWNED_HERDR_CLIENT_RELEASE_TAG = '([^']+)'/;
const MERGE_ABANDONED = "merging upstream's changes stopped, the merge was abandoned and the tree is as it was";
const MERGE_TREE_CLEAN = 0;
const MERGE_TREE_CONFLICT = 1;
const FILES_EACH_TOOL_SERVES_FROM = {
  ntfy: ['systemd/ntfy-serve', 'systemd/ntfy-server.yml'],
  conduwuit: ['systemd/conduwuit-serve', 'systemd/conduwuit.toml'],
  forgejo: ['systemd/forgejo-serve'],
};

export class UpdateStopped extends Error {}

export function refused(reason) {
  return new UpdateStopped(`REFUSING — ${reason}`);
}

export function failed(reason) {
  return new UpdateStopped(`FAILED: ${reason}`);
}

function gitResult(context, args) {
  return context.runProcess('git', ['-C', context.root, ...args]);
}

function git(context, args) {
  const result = gitResult(context, args);
  if (result.status !== 0) throw failed(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function remoteUrl(context, remote) {
  const result = gitResult(context, ['remote', 'get-url', remote]);
  return result.status === 0 ? result.stdout.trim() : '';
}

function repositoryNameIn(url) {
  return url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).at(-1);
}

export async function askGithubAboutRepository(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(SECONDS_TO_WAIT_FOR_HOST * 1000),
  });
  if (!response.ok) throw new Error(`github answered ${response.status}`);
  const answer = await response.json();
  return { fork: answer.fork === true, parentUrl: answer.parent?.clone_url };
}

async function kindFromTheHost(context, originUrl) {
  const repository = GITHUB_REPOSITORY_IN_URL.exec(originUrl)?.[1];
  if (repository === undefined) {
    return { kind: CHECKOUT_KINDS.PUBLIC, reason: 'origin is not on github.com and there is no upstream remote', source: ORIGIN_REMOTE };
  }
  try {
    const answer = await context.askHost(repository);
    return answer.fork
      ? { kind: CHECKOUT_KINDS.FORK, reason: `github reports origin as a fork of ${answer.parentUrl}`, source: answer.parentUrl }
      : { kind: CHECKOUT_KINDS.PUBLIC, reason: 'github reports origin is not a fork', source: ORIGIN_REMOTE };
  } catch (error) {
    return {
      kind: CHECKOUT_KINDS.PUBLIC,
      reason: `github could not be asked whether origin is a fork (${error.message}), so this reads as public`,
      source: ORIGIN_REMOTE,
    };
  }
}

export async function detectCheckoutKind(context) {
  const originUrl = remoteUrl(context, ORIGIN_REMOTE);
  if (repositoryNameIn(originUrl).endsWith(PRIVATE_NAME_SUFFIX)) {
    return { kind: CHECKOUT_KINDS.PRIVATE, reason: `origin's name ends ${PRIVATE_NAME_SUFFIX}`, source: ORIGIN_REMOTE };
  }
  if (remoteUrl(context, UPSTREAM_REMOTE) !== '') {
    return { kind: CHECKOUT_KINDS.FORK, reason: `it has a remote named ${UPSTREAM_REMOTE}`, source: UPSTREAM_REMOTE };
  }
  return kindFromTheHost(context, originUrl);
}

function defaultBranchOf(context, source) {
  const branch = DEFAULT_BRANCH_LINE.exec(git(context, ['ls-remote', '--symref', source, 'HEAD']))?.[1];
  if (branch === undefined) throw failed(`${source} does not name a default branch`);
  return branch;
}

function fetchLatestCommit(context, source, branch) {
  git(context, ['fetch', source, branch]);
  return git(context, ['rev-parse', 'FETCH_HEAD']);
}

function commitIsAncestor(context, ancestor, descendant) {
  return gitResult(context, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

function branchRelation(context, head, target) {
  if (head === target) return BRANCH_RELATIONS.SAME;
  if (commitIsAncestor(context, head, target)) return BRANCH_RELATIONS.BEHIND;
  if (commitIsAncestor(context, target, head)) return BRANCH_RELATIONS.AHEAD;
  return BRANCH_RELATIONS.DIVERGED;
}

export function hasNewCommits(relation) {
  return relation === BRANCH_RELATIONS.BEHIND || relation === BRANCH_RELATIONS.DIVERGED;
}

export function readCheckoutState(context, checkout) {
  const ownBranch = defaultBranchOf(context, ORIGIN_REMOTE);
  const sourceBranch = checkout.source === ORIGIN_REMOTE ? ownBranch : defaultBranchOf(context, checkout.source);
  const targetCommit = fetchLatestCommit(context, checkout.source, sourceBranch);
  const headCommit = git(context, ['rev-parse', 'HEAD']);
  const relation = branchRelation(context, headCommit, targetCommit);
  return {
    ownBranch,
    sourceBranch,
    targetCommit,
    headCommit,
    relation,
    newCommitCount: Number(git(context, ['rev-list', '--count', `${headCommit}..${targetCommit}`])),
    currentBranch: git(context, ['branch', '--show-current']),
    treeIsDirty: git(context, ['status', '--porcelain']) !== '',
    isLinkedWorktree: !isMainCheckoutRoot(context.root),
  };
}

export function checkoutRefusal(checkout, state) {
  if (state.isLinkedWorktree) {
    return 'this is a linked worktree; run the update from the main checkout';
  }
  if (state.currentBranch !== state.ownBranch) {
    return `the checkout is on ${state.currentBranch || 'a detached HEAD'}, not ${state.ownBranch}; switch to ${state.ownBranch} and run again`;
  }
  if (state.treeIsDirty) {
    return 'the working tree has uncommitted changes; commit or stash them and run again';
  }
  if (state.relation === BRANCH_RELATIONS.DIVERGED && checkout.kind !== CHECKOUT_KINDS.FORK) {
    return `${state.ownBranch} has diverged from ${checkout.source}; reconcile it by hand and run again`;
  }
  return undefined;
}

function mergeUpstream(context, state) {
  const merge = gitResult(context, ['merge', '--no-edit', state.targetCommit]);
  if (merge.status === 0) return;
  gitResult(context, ['merge', '--abort']);
  throw failed(`${MERGE_ABANDONED}: ${merge.stdout.trim()} ${merge.stderr.trim()}`);
}

export function pullLatest(context, checkout, state) {
  if (!hasNewCommits(state.relation)) return false;
  if (pullWillMakeAMergeCommit(checkout, state)) {
    mergeUpstream(context, state);
    return true;
  }
  git(context, ['merge', '--ff-only', state.targetCommit]);
  return false;
}

export function readCurrentCommit(context) {
  return git(context, ['rev-parse', 'HEAD']);
}

export function readCommittedFile(context, revision, file) {
  const result = gitResult(context, ['show', `${revision}:${file}`]);
  if (result.status !== 0) throw failed(`cannot read ${file} at ${revision}: ${result.stderr.trim()}`);
  return result.stdout;
}

function pinnedImagesIn(pins) {
  return Object.entries(pins.tools ?? {}).filter(([, tool]) => tool.image !== undefined);
}

function toolsWhoseImageMoved(oldPins, newPins) {
  const oldTools = oldPins.tools ?? {};
  return pinnedImagesIn(newPins)
    .filter(([name, tool]) => oldTools[name]?.image !== tool.image)
    .map(([name]) => name);
}

function toolsWhoseServedFilesChanged(context, oldRevision, newRevision) {
  const changedFiles = git(context, ['diff', '--name-only', oldRevision, newRevision]).split('\n');
  return Object.entries(FILES_EACH_TOOL_SERVES_FROM)
    .filter(([, files]) => files.some((file) => changedFiles.includes(file)))
    .map(([tool]) => tool);
}

function pullWillMakeAMergeCommit(checkout, state) {
  return checkout.kind === CHECKOUT_KINDS.FORK && state.relation === BRANCH_RELATIONS.DIVERGED;
}

function readTreeTheMergeWillMake(context, state) {
  const args = ['merge-tree', '--write-tree', '--name-only', state.headCommit, state.targetCommit];
  const merge = gitResult(context, args);
  if (merge.status !== MERGE_TREE_CLEAN && merge.status !== MERGE_TREE_CONFLICT) throw failed(`git ${args.join(' ')}: ${merge.stderr.trim()}`);
  const [tree, ...details] = merge.stdout.trim().split('\n');
  if (merge.status === MERGE_TREE_CLEAN) return { revision: tree };
  return { revision: state.headCommit, mergeConflict: `${MERGE_ABANDONED}: ${details.filter((line) => line !== '').join(' ')}` };
}

function whatThePullWillLeave(context, checkout, state) {
  if (!hasNewCommits(state.relation)) return { revision: state.headCommit };
  return pullWillMakeAMergeCommit(checkout, state) ? readTreeTheMergeWillMake(context, state) : { revision: state.targetCommit };
}

export function readPins(context, checkout, state) {
  const { revision, mergeConflict } = whatThePullWillLeave(context, checkout, state);
  const pins = JSON.parse(readCommittedFile(context, revision, VENDOR_PINS_FILE));
  const herdrTag = HERDR_PIN_LINE.exec(readCommittedFile(context, revision, HERDR_CLIENT_FILE))?.[1];
  if (herdrTag === undefined) throw failed(`${HERDR_CLIENT_FILE} at ${revision} pins no herdr release`);
  const oldPins = JSON.parse(readCommittedFile(context, state.headCommit, VENDOR_PINS_FILE));
  return {
    revision,
    mergeConflict,
    claude: pins.harnesses.claude.version,
    codex: pins.harnesses.codex.version,
    herdr: herdrTag.replace(/^v/, ''),
    toolsWhoseImageMoved: toolsWhoseImageMoved(oldPins, pins),
    toolsWhoseServedFilesChanged: toolsWhoseServedFilesChanged(context, state.headCommit, revision),
  };
}
