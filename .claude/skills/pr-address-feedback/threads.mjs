#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { ghProgramFor, parsePullRequestUrl } from '../pr-merge/stack.mjs';

const usage = 'usage: node threads.mjs <pull request url> [--all] [--json]';
const automatedAuthorSuffix = '[bot]';

function runGh(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

const threadsQuery = (owner, repo, number) => `{ repository(owner:"${owner}",name:"${repo}"){ pullRequest(number:${number}){ number title state headRefName baseRefName reviewThreads(first:100){ nodes{ id isResolved isOutdated path line comments(first:20){ nodes{ databaseId author{login} createdAt body } } } } } } }`;

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

export function rolledPullRequestsOf(program, owner, repo, headBranch) {
  const merged = JSON.parse(runGh(program, ['pr', 'list', '--repo', `${owner}/${repo}`, '--base', headBranch, '--state', 'merged', '--json', 'number', '--limit', '50']));
  return merged.map((pr) => pr.number);
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

function main() {
  const [url, ...flags] = process.argv.slice(2);
  const { host, owner, repo, number } = parsePullRequestUrl(url ?? '');
  const program = ghProgramFor(host);
  const includeResolved = flags.includes('--all');
  const root = readThreads(program, owner, repo, number, includeResolved);
  const rolled = rolledPullRequestsOf(program, owner, repo, root.head).map((rolledNumber) => readThreads(program, owner, repo, rolledNumber, includeResolved));
  const pullRequests = [root, ...rolled];
  if (flags.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ host, owner, repo, pullRequests }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderThreads(pullRequests)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${usage}\n${error.message}\n`);
    process.exit(1);
  }
}
