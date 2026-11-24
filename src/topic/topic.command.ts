import { Command, CommandRunner } from "nest-commander";
import { access, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import { TAB_AGENT_NAME_VARIABLE, isRegisteredStager } from "../stager-tree-refresh/stager-tree-refresh.ts";

export const TOPIC_FILE_NAME = "topic.md";
export const TOPIC_VERDICTS_FILE_NAME = "topic-verdicts.jsonl";

const USAGE = 'Usage: throne topic same|changed <slug>|none [--description "<one line>"]\n';

export interface TopicDependencies {
  readonly agentLedgerDirectory: string;
  readonly tabAgentName: string | undefined;
  now(): Date;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: TopicDependencies = {
  agentLedgerDirectory: THRONE_DATA_DIR,
  get tabAgentName() {
    return process.env[TAB_AGENT_NAME_VARIABLE];
  },
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface TopicVerdict {
  verdict: "same" | "changed" | "none";
  slug?: string;
  description?: string;
}

function parseTopicArguments(args: string[]): TopicVerdict {
  const positional: string[] = [];
  let description: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--description") {
      description = args[index + 1];
      index += 1;
      if (description === undefined || description.trim() === "") throw new Error("--description needs a one-line description");
      if (description.includes("\n")) throw new Error("--description must be one line");
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown flag "${argument}"`);
    } else {
      positional.push(argument);
    }
  }
  const [verdict, slug, ...extra] = positional;
  if (extra.length > 0) throw new Error(`unexpected argument "${extra[0]}"`);
  if (verdict === "changed") {
    if (slug === undefined) throw new Error("changed must name the new topic's slug");
    if (description !== undefined) throw new Error("changed keeps this Stager's own topic: drop --description");
    return { verdict, slug };
  }
  if (verdict === "same" || verdict === "none") {
    if (slug !== undefined) throw new Error(`${verdict} takes no slug`);
    return { verdict, description };
  }
  throw new Error("the verdict must be same, changed or none");
}

export async function runTopic(args: string[], dependencies: TopicDependencies = PRODUCTION_DEPENDENCIES): Promise<number> {
  let verdict: TopicVerdict;
  try {
    verdict = parseTopicArguments(args);
  } catch (error) {
    dependencies.writeStderr(`${USAGE}topic: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const agentName = dependencies.tabAgentName;
  if (agentName === undefined || agentName === "" || !(await isRegisteredStager(agentName, dependencies.agentLedgerDirectory))) {
    dependencies.writeStderr("topic: refused: only a registered Stager records a topic verdict\n");
    return 1;
  }
  const ledger = path.join(dependencies.agentLedgerDirectory, agentName);
  const topicFile = path.join(ledger, TOPIC_FILE_NAME);
  if (verdict.verdict === "same" && verdict.description === undefined && !(await access(topicFile).then(() => true, () => false))) {
    dependencies.writeStderr('topic: no topic is saved yet: name it with --description "<one line>"\n');
    return 2;
  }
  if (verdict.description !== undefined) await writeFile(topicFile, `${verdict.description.trim()}\n`);
  const record = {
    verdict: verdict.verdict,
    ...(verdict.slug === undefined ? {} : { slug: verdict.slug }),
    at: dependencies.now().toISOString(),
  };
  await appendFile(path.join(ledger, TOPIC_VERDICTS_FILE_NAME), `${JSON.stringify(record)}\n`);
  dependencies.writeStdout(`topic: recorded ${verdict.verdict}${verdict.slug === undefined ? "" : ` ${verdict.slug}`}\n`);
  return 0;
}

@Command({ name: "topic", allowUnknownOptions: true, allowExcessArgs: true })
export class TopicCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runTopic(passedParams);
  }
}
