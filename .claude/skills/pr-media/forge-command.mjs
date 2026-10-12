import { spawnSync } from 'node:child_process';

export const FORGE_COMMAND_ON_PATH = { path: 'throne' };
const FORGEJO = 'forgejo';

function runForge(forge, args) {
  const result = spawnSync(forge.path, ['forge', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`throne forge ${args.join(' ')} failed (exit ${result.status ?? result.error?.message}):\n${result.stderr ?? ''}${result.stdout ?? ''}`);
  }
  return result.stdout;
}

export function isForgejoPullRequest(forge, target) {
  return JSON.parse(runForge(forge, ['status', target, '--json'])).publishTo === FORGEJO;
}

export function viewForgejoPullRequest(forge, target) {
  return JSON.parse(runForge(forge, ['pr', 'view', target]));
}

export function attachToForgejoPullRequest(forge, target, filePath) {
  return JSON.parse(runForge(forge, ['attach', target, '--file', filePath]));
}

export function detachFromForgejoPullRequest(forge, target, url) {
  return JSON.parse(runForge(forge, ['detach', target, '--url', url]));
}

export function forgejoEditArguments(target, bodyFile) {
  return ['pr', 'edit', target, '--body-file', bodyFile];
}

export function editForgejoPullRequestBody(forge, target, bodyFile) {
  runForge(forge, forgejoEditArguments(target, bodyFile));
}
