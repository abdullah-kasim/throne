import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  openRegentQueueStore,
  type RegentQueueLaunchBriefStore,
} from "../regent-queue/regent-queue.store.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { herdrAgentNameRefusal } from "../herdr/herdr-identity.service.ts";
import {
  canonicalObjectiveCode,
  nameCarriesObjectiveCode,
} from "../shared-policy/objective-contract.ts";
import { localBranchTip } from "../git-lifecycle/branch-authority.ts";
import { repoRoot, runGit } from "../git-lifecycle/git-command.service.ts";
import { canonicalRegentAuthority } from "../shared-policy/regent-authority.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const REQUIRED_STAGE_FLAGS = [
  "objective-code",
  "name",
  "target-repo",
  "target-branch",
  "base-commit",
] as const;

export async function validateLaunchBriefFacts(input: {
  objectiveCode: string;
  canonicalName: string;
  targetRepo: string;
  targetBranch: string;
  baseCommit: string;
}): Promise<{ targetRepo: string; baseCommit: string }> {
  const canonical = canonicalObjectiveCode(input.objectiveCode);
  if (canonical === undefined || canonical !== input.objectiveCode)
    throw new Error(
      `objective code "${input.objectiveCode}" is not canonical lowercase ASCII alphanumeric`,
    );
  const nameRefusal = herdrAgentNameRefusal(input.canonicalName);
  if (nameRefusal !== undefined) throw new Error(nameRefusal);
  if (!nameCarriesObjectiveCode("alpha", input.canonicalName, canonical))
    throw new Error(
      `agent name "${input.canonicalName}" does not carry objective code "${canonical}" as alpha-${canonical}-…`,
    );
  if (!path.isAbsolute(input.targetRepo))
    throw new Error("--target-repo must be absolute");
  const root = await realpath(await repoRoot(input.targetRepo));
  if (root !== (await realpath(input.targetRepo)))
    throw new Error(`--target-repo must name the repository root (${root})`);
  const branchTip = await localBranchTip(root, input.targetBranch);
  if (branchTip === undefined)
    throw new Error(
      `target branch "${input.targetBranch}" does not exist locally in ${root}`,
    );
  let commit: string;
  try {
    commit = await runGit(
      ["rev-parse", "--verify", `${input.baseCommit}^{commit}`],
      root,
    );
  } catch {
    throw new Error(
      `base commit "${input.baseCommit}" is not a valid commit in ${root}`,
    );
  }
  if (commit !== branchTip)
    throw new Error(
      `base commit ${commit} is not the tip ${branchTip} of target branch "${input.targetBranch}"`,
    );
  if ((await localBranchTip(root, input.canonicalName)) !== undefined)
    throw new Error(
      `launch branch "${input.canonicalName}" already exists locally in ${root}`,
    );
  return { targetRepo: root, baseCommit: commit };
}

function parse(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--expire") parsed.expire = true;
    else if (token.startsWith("--")) {
      const value = args[++index];
      if (!value) throw new Error(`${token} requires a value`);
      parsed[token.slice(2)] = value;
    } else throw new Error(`unexpected argument "${token}"`);
  }
  return parsed;
}

export async function runStageLaunchBrief(
  args: string[],
  deps: {
    openStore: () => RegentQueueLaunchBriefStore;
    currentAgentName: () => Promise<string>;
    validateFacts?: typeof validateLaunchBriefFacts;
  } = {
    openStore: openRegentQueueStore,
    currentAgentName: resolveCurrentAgentName,
  },
): Promise<number> {
  let flags: Record<string, string | boolean>;
  try {
    flags = parse(args);
  } catch (error) {
    process.stderr.write(
      `stage-launch-brief: ${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal(
        {
          reason:
            "stage-launch-brief entrance validation refused this invocation.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n`,
    );
    return 1;
  }
  let liveIdentity: string;
  try {
    liveIdentity = await deps.currentAgentName();
  } catch (error) {
    process.stderr.write(
      `stage-launch-brief: cannot prove current authority: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const authorizer = canonicalRegentAuthority(liveIdentity);
  if (authorizer === undefined) {
    process.stderr.write(
      `stage-launch-brief: unauthorized: only the live Regent may stage or expire a launch brief; current agent is "${liveIdentity}"\n`,
    );
    return 1;
  }
  const objectiveCode = flags["objective-code"];
  if (typeof objectiveCode !== "string") {
    process.stderr.write(
      `stage-launch-brief: --objective-code is required\n${renderEntranceRefusal(
        {
          reason:
            "stage-launch-brief entrance validation requires --objective-code.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        },
      )}\n`,
    );
    return 1;
  }
  if (flags.expire !== true) {
    const missing = REQUIRED_STAGE_FLAGS.find(
      (flag) => typeof flags[flag] !== "string" || flags[flag] === "",
    );
    if (missing) {
      process.stderr.write(
        `stage-launch-brief: --${missing} is required when staging\n${renderEntranceRefusal(
          {
            reason: `stage-launch-brief entrance validation requires --${missing} when staging.`,
            bypass: undefined,
            supervisorRoute:
              "Ask your supervisor for an allowed alternative invocation.",
          },
        )}\n`,
      );
      return 1;
    }
  }
  const store = deps.openStore();
  try {
    let validated: { targetRepo: string; baseCommit: string } | undefined;
    if (flags.expire !== true) {
      validated = await (deps.validateFacts ?? validateLaunchBriefFacts)({
        objectiveCode,
        canonicalName: flags.name as string,
        targetRepo: flags["target-repo"] as string,
        targetBranch: flags["target-branch"] as string,
        baseCommit: flags["base-commit"] as string,
      });
      const briefs = store.readLaunchBriefs();
      if (briefs.state === "unknown")
        throw new Error(
          `cannot prove launch-brief collision state: ${briefs.reason}`,
        );
      const collision =
        briefs.state === "briefs"
          ? briefs.briefs.find(
              (brief) =>
                brief.lifecycle === "active" &&
                brief.canonicalName === flags.name &&
                brief.objectiveCode !== objectiveCode,
            )
          : undefined;
      if (collision !== undefined)
        throw new Error(
          `active launch brief for objective "${collision.objectiveCode}" already owns canonical name "${collision.canonicalName}"`,
        );
    }
    const brief =
      flags.expire === true
        ? store.expireLaunchBrief(objectiveCode, authorizer)
        : store.stageLaunchBrief({
            objectiveCode,
            canonicalName: flags.name as string,
            targetRepo: validated!.targetRepo,
            targetBranch: flags["target-branch"] as string,
            baseCommit: validated!.baseCommit,
            authorizer,
          });
    const modelHintSuffix =
      brief.modelHint === null
        ? ""
        : ` model_hint ${brief.modelHint.harness}/${brief.modelHint.model}`;
    process.stdout.write(
      `stage-launch-brief: ${brief.lifecycle} "${brief.objectiveCode}" as "${brief.canonicalName}" authorized by ${brief.authorizer} at ${brief.briefedAt}${modelHintSuffix}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `stage-launch-brief: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    store.close();
  }
}
