import { execFileSync } from 'node:child_process';

const YOLO_KEY = 'throne.yolo';
const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;
const PUSH_REMOTE = 'origin';

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function pathsHaveChanges(repository, paths) {
  return git(repository, ['status', '--porcelain', '--', ...paths]) !== '';
}

function repositoryIsYolo(repository) {
  try {
    return git(repository, ['config', '--type=bool', '--get', YOLO_KEY]) === 'true';
  } catch (error) {
    if (error.status === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return false;
    throw error;
  }
}

function pathsHaveUnpushedCommits(repository, paths) {
  return git(repository, ['log', '--format=%h', 'HEAD', '--not', `--remotes=${PUSH_REMOTE}`, '--', ...paths]) !== '';
}

function commitPathsPastTheLiveMainGuard(repository, paths, message) {
  git(repository, ['commit', '--only', '--no-verify', '-m', message, '--', ...paths]);
  return git(repository, ['rev-parse', '--short', 'HEAD']);
}

function pushCurrentBranch(repository) {
  const branch = git(repository, ['branch', '--show-current']);
  try {
    git(repository, ['push', PUSH_REMOTE, branch]);
    return { pushed: true, pushRefused: false, detail: `pushed to ${PUSH_REMOTE} ${branch}` };
  } catch (error) {
    const reason = (error.stderr || error.message).trim();
    return { pushed: false, pushRefused: true, detail: `FAILED: push to ${PUSH_REMOTE} ${branch} was refused, the commit is kept: ${reason}` };
  }
}

export function landPinCommit({ repository, paths, message }) {
  const pushAfterCommit = repositoryIsYolo(repository);
  if (!pathsHaveChanges(repository, paths)) {
    const unchanged = `no pin commit: ${paths.join(', ')} unchanged`;
    if (!pushAfterCommit || !pathsHaveUnpushedCommits(repository, paths)) {
      return { committed: false, pushed: false, pushRefused: false, detail: unchanged };
    }
    const push = pushCurrentBranch(repository);
    return { committed: false, ...push, detail: `${unchanged}; ${push.detail}` };
  }
  const commit = commitPathsPastTheLiveMainGuard(repository, paths, message);
  const landed = `${commit} "${message}"`;
  if (!pushAfterCommit) {
    return { committed: true, pushed: false, pushRefused: false, detail: `${landed} committed, not pushed: ${YOLO_KEY} is not true` };
  }
  const push = pushCurrentBranch(repository);
  return { committed: true, ...push, detail: `${landed} committed; ${push.detail}` };
}
