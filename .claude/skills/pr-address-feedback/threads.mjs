#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { FORGE, ghEnvironmentFor, ghWorkingDirectoryFor, parsePullRequestUrl, pullRequestStatusOf } from '../pr-merge/stack.mjs';

const usage = 'usage: node threads.mjs <pull request url> [--all] [--json]';
const automatedAuthorSuffix = '[bot]';
const stagesWithFeedbackInForgejo = ['forgejo-only', 'promoted'];

function runGh(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ghEnvironmentFor(program), cwd: ghWorkingDirectoryFor(program) });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

const threadsQuery = (owner, repo, number) => `{ repository(owner:"${owner}",name:"${repo}"){ pullRequest(number:${number}){ number title state headRefName baseRefName reviewThreads(first:100){ nodes{ id isResolved isOutdated path line originalLine comments(first:20){ nodes{ databaseId author{login} createdAt body } } } } } } }`;

export function readThreads(program, owner, repo, number, includeResolved) {
  const data = JSON.parse(runGh(program, ['api', 'graphql', '-f', `query=${threadsQuery(owner, repo, number)}`]));
  const pullRequest = data.data.repository.pullRequest;
  const threads = pullRequest.reviewThreads.nodes
    .filter((thread) => includeResolved || !thread.isResolved)
    .map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      comments: thread.comments.nodes.map((comment) => ({ id: comment.databaseId, author: comment.author?.login ?? 'unknown', at: comment.createdAt, body: comment.body })),
    }));
  return { number: pullRequest.number, title: pullRequest.title, state: pullRequest.state, head: pullRequest.headRefName, base: pullRequest.baseRefName, threads, conversation: readConversation(program, owner, repo, number) };
}

export function readConversation(program, owner, repo, number) {
  const issueComments = JSON.parse(runGh(program, ['api', `repos/${owner}/${repo}/issues/${number}/comments`, '--paginate']))
    .map((comment) => ({ kind: 'comment', id: comment.id, author: comment.user?.login ?? 'unknown', at: comment.created_at, body: comment.body ?? '' }));
  const reviewBodies = JSON.parse(runGh(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--paginate']))
    .filter((review) => (review.body ?? '').trim() !== '')
    .map((review) => ({ kind: `review ${review.state}`, id: review.id, author: review.user?.login ?? 'unknown', at: review.submitted_at ?? '', body: review.body }));
  return [...issueComments, ...reviewBodies].sort((left, right) => left.at.localeCompare(right.at));
}

export function latestPerAutomatedAuthor(conversation) {
  const latest = new Map();
  for (const entry of conversation) if (entry.author.endsWith(automatedAuthorSuffix)) latest.set(entry.author, entry);
  return new Set([...latest.values()].map((entry) => entry.id));
}

function pullRequestsBasedOn(program, owner, repo, branch) {
  return JSON.parse(runGh(program, ['pr', 'list', '--repo', `${owner}/${repo}`, '--base', branch, '--state', 'all', '--json', 'number,headRefName,state', '--limit', '100']))
    .filter((pr) => pr.state !== 'OPEN');
}

export function rolledPullRequestsOf(program, owner, repo, headBranch) {
  const found = [];
  const seenBranches = new Set([headBranch]);
  let frontier = [headBranch];
  while (frontier.length > 0) {
    const next = [];
    for (const branch of frontier) {
      for (const pr of pullRequestsBasedOn(program, owner, repo, branch)) {
        if (found.includes(pr.number)) continue;
        found.push(pr.number);
        if (!seenBranches.has(pr.headRefName)) {
          seenBranches.add(pr.headRefName);
          next.push(pr.headRefName);
        }
      }
    }
    frontier = next;
  }
  return found;
}

export function renderThreads(pullRequests) {
  const lines = [];
  for (const pr of pullRequests) {
    lines.push(`== #${pr.number} ${pr.state} ${pr.head} -> ${pr.base}: ${pr.title}`);
    if (pr.threads.length === 0) lines.push('   no unresolved threads');
    for (const thread of pr.threads) {
      const first = thread.comments[0];
      lines.push(`-- thread ${thread.id}${thread.outdated ? ' (outdated)' : ''}${thread.resolved ? ' (resolved)' : ''} ${thread.path ?? ''}${thread.line ? `:${thread.line}` : ''}`);
      lines.push(`   opened by ${first?.author ?? 'unknown'}, ${thread.comments.length} comment(s), last by ${thread.comments.at(-1)?.author ?? 'unknown'}`);
      for (const comment of thread.comments) lines.push(`   [${comment.id}] ${comment.author} ${comment.at.slice(0, 16)}: ${comment.body.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    const latestAutomated = latestPerAutomatedAuthor(pr.conversation ?? []);
    const conversation = (pr.conversation ?? []).filter((entry) => !entry.author.endsWith(automatedAuthorSuffix) || latestAutomated.has(entry.id));
    lines.push(`-- conversation: ${conversation.length} comment(s) and review bodies${(pr.conversation ?? []).length > conversation.length ? ` (older reports from automated reviewers omitted; only each one's latest is shown)` : ''}`);
    for (const entry of conversation) lines.push(`   [${entry.kind} ${entry.id}] ${entry.author} ${entry.at.slice(0, 16)}: ${entry.body.replace(/\s+/g, ' ').slice(0, 1200)}`);
  }
  return lines.join('\n');
}

export function dumpFeedback(program, { host, owner, repo, number }, includeResolved) {
  const root = readThreads(program, owner, repo, number, includeResolved);
  const rolled = rolledPullRequestsOf(program, owner, repo, root.head).map((rolledNumber) => readThreads(program, owner, repo, rolledNumber, includeResolved));
  return { host, owner, repo, pullRequests: [root, ...rolled] };
}

export function feedbackLivesInForgejo(status) {
  return stagesWithFeedbackInForgejo.includes(status.stage) || status.mergeTarget === null;
}

export function feedbackInForgejoMessage(url, status) {
  return status.publishTo === FORGE.github
    ? `${url} is staged in Forgejo as ${status.forgejo.url}; copy its GitHub feedback there with \`throne forge mirror-feedback ${url}\`, then read it with \`throne forge pr feedback ${url}\``
    : `${url} is a Forgejo pull request; read its feedback with \`throne forge pr feedback ${url}\``;
}

async function main() {
  const [url, ...flags] = process.argv.slice(2);
  const pullRequest = parsePullRequestUrl(url ?? '');
  const status = await pullRequestStatusOf(url);
  if (feedbackLivesInForgejo(status)) throw new Error(feedbackInForgejoMessage(url, status));
  const dump = dumpFeedback(status.mergeTarget.program, pullRequest, flags.includes('--all'));
  if (flags.includes('--json')) {
    process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderThreads(dump.pullRequests)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${usage}\n${error.message}\n`);
    process.exit(1);
  });
}
