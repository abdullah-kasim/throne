#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FORGE, ghEnvironmentFor, ghWorkingDirectoryFor, parsePullRequestUrl, pullRequestStatusOf, runForgeSeam } from '../pr-merge/stack.mjs';

const usage = 'usage: node pending-review.mjs <pull request url> <comments.json> [--dry-run] [--to-github]';
const guardMarker = 'throne-gh-guard-shim';

function whichProgram(program) {
  const result = spawnSync('/usr/bin/which', [program], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function guardBypassArguments(program) {
  const location = whichProgram(program);
  if (!location) return [];
  try {
    return readFileSync(location, 'latin1').includes(guardMarker) ? ['--bypass'] : [];
  } catch {
    return [];
  }
}

function runGh(program, args, input) {
  const result = spawnSync(program, [...guardBypassArguments(program), ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: ghEnvironmentFor(program), cwd: ghWorkingDirectoryFor(program) });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`);
  return result.stdout;
}

export function validateComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) throw new Error('comments.json must be a non-empty array of { path, line, body } (optionally start_line)');
  for (const [index, comment] of comments.entries()) {
    if (typeof comment.path !== 'string' || comment.path === '') throw new Error(`comment ${index}: path is required`);
    if (!Number.isInteger(comment.line) || comment.line < 1) throw new Error(`comment ${index}: line must be a positive integer on the new side of the diff`);
    if (typeof comment.body !== 'string' || comment.body.trim() === '') throw new Error(`comment ${index}: body is required`);
    if (comment.start_line !== undefined && (!Number.isInteger(comment.start_line) || comment.start_line >= comment.line)) throw new Error(`comment ${index}: start_line must be an integer below line`);
  }
  return comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: 'RIGHT',
    body: comment.body,
    ...(comment.start_line === undefined ? {} : { start_line: comment.start_line, start_side: 'RIGHT' }),
  }));
}

export function pendingReviewPayload(headSha, comments) {
  return { commit_id: headSha, comments };
}

function readComments(commentsPath) {
  return JSON.parse(readFileSync(commentsPath, 'utf8'));
}

function unstagedGithubRefusal(url) {
  return `${url} is not staged in Forgejo, so nothing was written: stage it first with \`throne forge stage ${url}\`, then leave the review on its Forgejo twin.`;
}

function forgejoUrlToGithubRefusal(url) {
  return `${url} is a Forgejo pull request, so nothing was written: a GitHub pending review goes on the GitHub twin's url.`;
}

async function leaveForgejoReview(url, commentsPath, status, flags, { runSeam, writeOutput }) {
  if (status.forgejo === null) throw new Error(unstagedGithubRefusal(url));
  const comments = readComments(commentsPath);
  validateComments(comments);
  if (flags.includes('--dry-run')) {
    writeOutput(`${JSON.stringify({ forgejoPullRequest: status.forgejo.url, comments }, null, 2)}\n`);
    return;
  }
  writeOutput(await runSeam(['pr', 'review', url, '--comments-file', commentsPath]));
}

function leaveGithubPendingReview(url, commentsPath, status, flags, { runGithub, writeOutput }) {
  if (status.publishTo === FORGE.forgejo) throw new Error(forgejoUrlToGithubRefusal(url));
  const { owner, repo, number } = parsePullRequestUrl(url);
  const { program } = status.mergeTarget;
  const comments = validateComments(readComments(commentsPath));
  const headSha = runGithub(program, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'headRefOid', '--jq', '.headRefOid']).trim();
  const payload = pendingReviewPayload(headSha, comments);
  if (flags.includes('--dry-run')) {
    writeOutput(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const review = JSON.parse(runGithub(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'], JSON.stringify(payload)));
  const readBack = JSON.parse(runGithub(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}`]));
  const attached = JSON.parse(runGithub(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}/comments`, '--paginate']));
  writeOutput(`pending review ${review.id} on #${number}: state ${readBack.state}, ${attached.length} of ${comments.length} comments attached, at ${headSha.slice(0, 10)}\n${readBack.html_url ?? ''}\n`);
  if (readBack.state !== 'PENDING') throw new Error(`review ${review.id} is ${readBack.state}, not PENDING`);
}

export async function leavePendingReview(url, commentsPath, flags, { runSeam = runForgeSeam, runGithub = runGh, writeOutput = (text) => process.stdout.write(text) } = {}) {
  if (!url || !commentsPath) throw new Error(usage);
  const status = await pullRequestStatusOf(url, runSeam);
  if (flags.includes('--to-github')) return leaveGithubPendingReview(url, commentsPath, status, flags, { runGithub, writeOutput });
  return leaveForgejoReview(url, commentsPath, status, flags, { runSeam, writeOutput });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [url, commentsPath, ...flags] = process.argv.slice(2);
  leavePendingReview(url, commentsPath, flags).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
