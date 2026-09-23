import type { BriefCommandRunner, BriefSection } from "./brief-command-runner.ts";

const PULL_REQUEST_TIMEOUT = 15_000;
const PULL_REQUEST_LIMIT = 30;

interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  readonly url: string;
  readonly files?: ReadonlyArray<{ readonly path: string }>;
}

function filesTheBodyNames(pullRequest: OpenPullRequest, body: string): string[] {
  return (pullRequest.files ?? [])
    .map((file) => file.path)
    .filter((filePath) => body.includes(filePath));
}

export async function readOpenPullRequests(
  run: BriefCommandRunner,
  input: { readonly repository: string; readonly branch: string; readonly body: string },
): Promise<BriefSection> {
  const title = "Open pull requests touching the same branch or files";
  const listing = await run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      String(PULL_REQUEST_LIMIT),
      "--json",
      "number,title,headRefName,url,files",
    ],
    input.repository,
    PULL_REQUEST_TIMEOUT,
  );
  if (!listing.ok) {
    return { title, trimmable: true, lines: [`Unavailable (${listing.detail}).`] };
  }
  let pullRequests: OpenPullRequest[];
  try {
    pullRequests = JSON.parse(listing.stdout) as OpenPullRequest[];
  } catch {
    return { title, trimmable: true, lines: ["Unavailable (gh returned something that is not JSON)."] };
  }
  const relevant = pullRequests
    .map((pullRequest) => ({ pullRequest, sharedFiles: filesTheBodyNames(pullRequest, input.body) }))
    .filter(({ pullRequest, sharedFiles }) => pullRequest.headRefName === input.branch || sharedFiles.length > 0);
  return {
    title,
    trimmable: true,
    lines:
      relevant.length === 0
        ? [`None of the ${pullRequests.length} most recent open pull requests share this branch or a file the body names.`]
        : relevant.map(({ pullRequest, sharedFiles }) => {
            const why =
              pullRequest.headRefName === input.branch
                ? "this branch"
                : `files: ${sharedFiles.join(", ")}`;
            return `- #${pullRequest.number} ${pullRequest.title} (${pullRequest.headRefName}; ${why}) ${pullRequest.url}`;
          }),
  };
}
