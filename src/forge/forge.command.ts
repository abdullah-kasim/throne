import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { FORGE_USAGE, parseForgeArguments, type ForgeInvocation } from "./forge-arguments.ts";
import { PRODUCTION_FORGE_DEPENDENCIES, type ForgeDependencies, type ProcessResult } from "./forge-dependencies.ts";
import { messageOf } from "./forge-refusal.ts";
import { mirrorFeedbackToTwin } from "./feedback-mirror.ts";
import { answerForgejoFeedback, listForgejoFeedback } from "./forgejo-answers.ts";
import { closeMergedTwin, squashMergePullRequestOnGithub } from "./merging-on-github.ts";
import { openPullRequest } from "./open-pull-request.ts";
import { promotePullRequest } from "./promotion.ts";
import { stageGithubPullRequest } from "./staging.ts";
import {
  attachToPullRequest,
  commentOnPullRequest,
  createPullRequest,
  detachFromPullRequest,
  diffPullRequest,
  editPullRequestBody,
  ensureRepository,
  listOpenPullRequests,
  printedJson,
  pushBranch,
  renderMarkdown,
  syncBranches,
  viewPullRequest,
  type ForgeContext,
} from "./pull-request-operations.ts";
import { DEFAULT_OPEN_PULL_REQUEST_LIMIT } from "./pull-request-shapes.ts";
import { pullRequestStatus, pullRequestStatusLines } from "./pull-request-status.ts";
import { cleanUpReviewWorktrees } from "./review-worktree-cleanup.ts";

export interface ForgeCommandIo {
  readonly cwd: () => string;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

const PRODUCTION_IO: ForgeCommandIo = {
  cwd: () => process.cwd(),
  writeStdout: (text) => void process.stdout.write(text),
  writeStderr: (text) => void process.stderr.write(text),
};

async function printedPullRequestStatus(context: ForgeContext, invocation: ForgeInvocation): Promise<ProcessResult> {
  const status = await pullRequestStatus(context, invocation.target!);
  return invocation.flags.has("--json") ? printedJson(status) : { exitCode: 0, stdout: pullRequestStatusLines(status), stderr: "" };
}

function openOrCleanUp(context: ForgeContext, invocation: ForgeInvocation): Promise<ProcessResult> {
  if (invocation.flags.has("--cleanup")) return cleanUpReviewWorktrees(context);
  return openPullRequest(context, invocation.target!, {
    explicitRepo: invocation.values.get("--repo"),
    editor: invocation.values.get("--editor"),
    printOnly: invocation.flags.has("--print"),
  });
}

async function printedJsonOf(result: Promise<unknown>): Promise<ProcessResult> {
  return printedJson(await result);
}

function performForgeOperation(context: ForgeContext, invocation: ForgeInvocation): Promise<ProcessResult> {
  const value = (name: string) => invocation.values.get(name)!;
  const target = invocation.target!;
  switch (invocation.operation) {
    case "status":
      return printedPullRequestStatus(context, invocation);
    case "open":
      return openOrCleanUp(context, invocation);
    case "ensure-repository":
      return ensureRepository(context, invocation.values.get("--base"));
    case "push-branch":
      return pushBranch(context, value("--branch"), invocation.values.get("--base"));
    case "pr create":
      return createPullRequest(context, {
        title: value("--title"),
        bodyFile: value("--body-file"),
        base: value("--base"),
        head: value("--head"),
        draft: invocation.flags.has("--draft"),
      });
    case "pr view":
      return viewPullRequest(context, target);
    case "pr edit":
      return editPullRequestBody(context, target, value("--body-file"));
    case "pr list":
      return listOpenPullRequests(context, Number(invocation.values.get("--limit") ?? DEFAULT_OPEN_PULL_REQUEST_LIMIT));
    case "pr diff":
      return diffPullRequest(context, target);
    case "pr merge":
      return squashMergePullRequestOnGithub(context, target);
    case "pr comment":
      return commentOnPullRequest(context, target, value("--body-file"));
    case "pr feedback":
      return printedJsonOf(listForgejoFeedback(context, target));
    case "pr answer":
      return printedJsonOf(
        answerForgejoFeedback(context, target, {
          commentId: Number(value("--comment")),
          bodyFile: value("--body-file"),
          resolve: invocation.flags.has("--resolve"),
        }),
      );
    case "promote":
      return printedJsonOf(promotePullRequest(context, target));
    case "stage":
      return printedJsonOf(stageGithubPullRequest(context, target));
    case "mirror-feedback":
      return printedJsonOf(mirrorFeedbackToTwin(context, target));
    case "close-merged-twin":
      return printedJsonOf(closeMergedTwin(context, target));
    case "attach":
      return attachToPullRequest(context, target, value("--file"));
    case "detach":
      return detachFromPullRequest(context, target, value("--url"));
    case "render-markdown":
      return renderMarkdown(context, value("--file"));
    case "sync-branches":
      return syncBranches(context);
  }
}

export async function runForge(
  args: readonly string[],
  dependencies: ForgeDependencies = PRODUCTION_FORGE_DEPENDENCIES,
  io: ForgeCommandIo = PRODUCTION_IO,
): Promise<number> {
  let invocation: ForgeInvocation;
  try {
    invocation = parseForgeArguments(args);
  } catch (error) {
    io.writeStderr(FORGE_USAGE);
    io.writeStderr(
      `${renderEntranceRefusal({
        reason: `forge entrance validation refused: ${messageOf(error)}.`,
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return 2;
  }
  const context: ForgeContext = {
    repo: invocation.values.get("--repo") ?? io.cwd(),
    bypass: invocation.flags.has("--bypass"),
    dependencies,
  };
  try {
    const result = await performForgeOperation(context, invocation);
    io.writeStdout(result.stdout);
    io.writeStderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    io.writeStderr(`forge ${invocation.operation}: ${messageOf(error)}\n`);
    return 1;
  }
}

@Command({
  name: "forge",
  description:
    "Work with pull requests on this host's forge: Forgejo when it is installed and answering, otherwise GitHub through gh; promote a Forgejo pull request to GitHub, stage an existing GitHub pull request in Forgejo, and stage its review feedback in Forgejo; merge only on GitHub and close the Forgejo twin once it is merged there.",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ForgeCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runForge(passedParams);
  }
}
