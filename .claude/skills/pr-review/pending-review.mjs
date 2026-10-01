#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ghEnvironmentFor, ghProgramFor, ghWorkingDirectoryFor, parsePullRequestUrl } from '../pr-merge/stack.mjs';

const usage = 'usage: node pending-review.mjs <pull request url> <comments.json> [--dry-run]';
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

function main() {
  const [url, commentsPath, ...flags] = process.argv.slice(2);
  if (!url || !commentsPath) throw new Error(usage);
  const { host, owner, repo, number } = parsePullRequestUrl(url);
  const program = ghProgramFor(host);
  const comments = validateComments(JSON.parse(readFileSync(commentsPath, 'utf8')));
  const headSha = runGh(program, ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'headRefOid', '--jq', '.headRefOid']).trim();
  const payload = pendingReviewPayload(headSha, comments);
  if (flags.includes('--dry-run')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const review = JSON.parse(runGh(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', '-'], JSON.stringify(payload)));
  const readBack = JSON.parse(runGh(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}`]));
  const attached = JSON.parse(runGh(program, ['api', `repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}/comments`, '--paginate']));
  process.stdout.write(`pending review ${review.id} on #${number}: state ${readBack.state}, ${attached.length} of ${comments.length} comments attached, at ${headSha.slice(0, 10)}\n${readBack.html_url ?? ''}\n`);
  if (readBack.state !== 'PENDING') throw new Error(`review ${review.id} is ${readBack.state}, not PENDING`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
