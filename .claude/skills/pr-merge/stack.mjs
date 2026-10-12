#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const usage = 'usage: node stack.mjs <pull request url> [--json]   (a Forgejo or staged pull request: run it from the local checkout)';
const forgeSeamProgram = fileURLToPath(new URL('../../../bin/throne-cli', import.meta.url));

export const FORGE = { forgejo: 'forgejo', github: 'github' };

export function parsePullRequestUrl(url) {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/.exec(url ?? '');
  if (!match) throw new Error(`${usage}\nnot a pull request url: ${url}`);
  return { host: match[1], owner: match[2], repo: match[3], number: Number(match[4]) };
}

export function ghWorkingDirectoryFor(program) {
  return program === 'gh' ? tmpdir() : undefined;
}

export function ghEnvironmentFor(program) {
  return program === 'gh' ? { ...process.env, GH_HOST: 'github.com' } : process.env;
}

export function runForgeSeam(args) {
  const result = spawnSync(forgeSeamProgram, ['forge', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`forge ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

export async function pullRequestStatusOf(url, runSeam = runForgeSeam) {
  return JSON.parse(await runSeam(['status', url, '--json']));
}

function runGh(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ghEnvironmentFor(program), cwd: ghWorkingDirectoryFor(program) });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

function runGhJson(program, args) {
  return JSON.parse(runGh(program, args));
}

const listFields = 'number,title,url,headRefName,baseRefName,state,isDraft,reviewDecision,mergeable,mergeStateStatus';
const pullRequestFields = `${listFields},commits`;

export function describePullRequest(raw) {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    head: raw.headRefName,
    base: raw.baseRefName,
    state: raw.state,
    draft: raw.isDraft,
    review: raw.reviewDecision || 'NONE',
    mergeable: raw.mergeable,
    commitCount: raw.commits?.length ?? null,
  };
}

export function defaultBranchOf(program, owner, repo) {
  return runGh(program, ['repo', 'view', `${owner}/${repo}`, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
}

function viewPullRequest(program, owner, repo, number) {
  return describePullRequest(runGhJson(program, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', pullRequestFields]));
}

function openPullRequestsBasedOn(program, owner, repo, branch) {
  return runGhJson(program, ['pr', 'list', '--repo', `${owner}/${repo}`, '--base', branch, '--state', 'open', '--json', listFields, '--limit', '100']).map(describePullRequest);
}

export function findRoot(program, owner, repo, start, defaultBranch, byHead) {
  let current = start;
  const visited = new Set([current.number]);
  while (current.base !== defaultBranch) {
    const parent = byHead(current.base);
    if (!parent) throw new Error(`#${current.number} is based on ${current.base}, which is not ${defaultBranch} and has no open pull request; the stack is broken there`);
    if (visited.has(parent.number)) throw new Error(`pull requests #${current.number} and #${parent.number} form a cycle`);
    visited.add(parent.number);
    current = parent;
  }
  return current;
}

export function buildStack(program, owner, repo, root, childrenOf) {
  const layers = [];
  let frontier = [root];
  const seen = new Set([root.number]);
  while (frontier.length > 0) {
    layers.push(frontier);
    const next = [];
    for (const parent of frontier) {
      for (const child of childrenOf(parent.head)) {
        if (seen.has(child.number)) continue;
        seen.add(child.number);
        child.parent = parent.number;
        next.push(child);
      }
    }
    frontier = next;
  }
  return layers;
}

export function renderStack(defaultBranch, layers) {
  const lines = [`default branch: ${defaultBranch}`];
  layers.forEach((layer, depth) => {
    for (const pr of layer) {
      const indent = '  '.repeat(depth);
      const flags = [pr.draft ? 'draft' : 'ready', `review=${pr.review}`, `mergeable=${pr.mergeable}`, pr.commitCount === null ? '' : `${pr.commitCount} commits`].filter(Boolean).join(', ');
      lines.push(`${indent}#${pr.number} ${pr.head} -> ${pr.base}  (${flags})  ${pr.title}`);
    }
  });
  const rolled = layers.slice(1).flat();
  lines.push(rolled.length === 0 ? 'nothing is stacked on the root' : `roll-up order into #${layers[0][0].number}: ${rolled.map((pr) => `#${pr.number}`).join(', ')}`);
  return lines.join('\n');
}

export function discoverGithubStack(program, { host, owner, repo, number }) {
  const defaultBranch = defaultBranchOf(program, owner, repo);
  const start = viewPullRequest(program, owner, repo, number);
  const openByHead = new Map();
  for (const pr of runGhJson(program, ['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'open', '--json', listFields, '--limit', '200']).map(describePullRequest)) openByHead.set(pr.head, pr);
  const root = findRoot(program, owner, repo, start, defaultBranch, (head) => openByHead.get(head));
  const layers = buildStack(program, owner, repo, root, (head) => openPullRequestsBasedOn(program, owner, repo, head));
  for (const pr of layers.flat()) pr.commitCount = viewPullRequest(program, owner, repo, pr.number).commitCount;
  return { host, owner, repo, defaultBranch, root: root.number, layers };
}

async function mergeTargetOf(url, runSeam = runForgeSeam) {
  const status = await pullRequestStatusOf(url, runSeam);
  if (status.mergeTarget === null) throw new Error(status.mergeTargetRefusal);
  return status.mergeTarget;
}

export async function discoverStackToMerge(url, runSeam = runForgeSeam) {
  const target = await mergeTargetOf(url, runSeam);
  const stack = discoverGithubStack(target.program, parsePullRequestUrl(target.url));
  const rootUrl = stack.layers[0][0].url;
  const root = rootUrl === target.url ? target : await mergeTargetOf(rootUrl, runSeam);
  return root.forgejoUrl ? { ...stack, forgejoTwin: root.forgejoUrl } : stack;
}

function renderForgejoTwin(stack) {
  return `root #${stack.root} is staged in Forgejo as ${stack.forgejoTwin}; after the merge, close it: throne forge close-merged-twin ${stack.layers[0][0].url}`;
}

async function main() {
  const [url, ...flags] = process.argv.slice(2);
  parsePullRequestUrl(url);
  const stack = await discoverStackToMerge(url);
  if (flags.includes('--json')) {
    process.stdout.write(`${JSON.stringify(stack, null, 2)}\n`);
    return;
  }
  const lines = [renderStack(stack.defaultBranch, stack.layers), ...(stack.forgejoTwin ? [renderForgejoTwin(stack)] : [])];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
