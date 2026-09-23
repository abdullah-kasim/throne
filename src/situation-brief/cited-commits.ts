import type { BriefCommandRunner, BriefSection } from "./brief-command-runner.ts";

const GIT_TIMEOUT = 10_000;
const MOST_CITED_COMMITS = 10;
const COMMIT_LIKE_TOKEN = /\b[0-9a-f]{7,40}\b/g;

function isShorterFormOfAnother(token: string, tokens: readonly string[]): boolean {
  return tokens.some((other) => other.length > token.length && other.startsWith(token));
}

export function citedCommitTokens(body: string): string[] {
  const tokens = [
    ...new Set(
      (body.match(COMMIT_LIKE_TOKEN) ?? []).filter((token) => /[a-f]/.test(token) && /[0-9]/.test(token)),
    ),
  ];
  return tokens
    .filter((token) => !isShorterFormOfAnother(token, tokens))
    .slice(0, MOST_CITED_COMMITS);
}

async function describeCitedCommit(
  run: BriefCommandRunner,
  repository: string,
  branch: string,
  token: string,
): Promise<string> {
  const resolved = await run("git", ["rev-parse", "--verify", `${token}^{commit}`], repository, GIT_TIMEOUT);
  if (!resolved.ok) {
    return `- ${token}: not a commit in this repository (it may belong to another one; check it there).`;
  }
  const tip = await run("git", ["rev-parse", "--verify", `${branch}^{commit}`], repository, GIT_TIMEOUT);
  if (!tip.ok) return `- ${token}: exists; branch "${branch}" is not local, so its position is unknown.`;
  if (tip.stdout === resolved.stdout) return `- ${token}: still the tip of "${branch}".`;
  const contained = await run("git", ["merge-base", "--is-ancestor", resolved.stdout, tip.stdout], repository, GIT_TIMEOUT);
  if (!contained.ok) return `- ${token}: exists but is NOT on "${branch}".`;
  const since = await run("git", ["rev-list", "--count", `${resolved.stdout}..${tip.stdout}`], repository, GIT_TIMEOUT);
  return `- ${token}: on "${branch}", which has moved ${since.ok ? since.stdout : "?"} commit(s) past it since.`;
}

export async function readCitedCommits(
  run: BriefCommandRunner,
  input: { readonly repository: string; readonly branch: string; readonly body: string },
): Promise<BriefSection> {
  const tokens = citedCommitTokens(input.body);
  const lines =
    tokens.length === 0
      ? ["The body cites no commit hashes."]
      : await Promise.all(
          tokens.map((token) => describeCitedCommit(run, input.repository, input.branch, token)),
        );
  return { title: "Commits the body cites", trimmable: true, lines };
}
