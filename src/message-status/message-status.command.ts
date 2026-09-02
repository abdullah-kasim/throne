import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  MESSAGE_STATUS_EXIT,
  MESSAGE_STATUS_ROUTE_PATH,
  runMessageStatus,
  type MessageStatusDeps,
  type MessageStatusRouteResult,
} from "./message-status.ts";
import { TransportClient } from "../transport/transport-client.ts";
import { resolveTransportMode } from "../transport/resolve-transport-mode.ts";

const TRANSPORT_FLAG = "--transport";
const LOCAL_FLAG = "--local";

interface ParsedMessageStatusArgs {
  readonly transport: string | undefined;
  readonly local: boolean;
  readonly remainingArgs: string[];
}

function parseMessageStatusArgs(args: readonly string[]): ParsedMessageStatusArgs {
  let transport: string | undefined;
  let local = false;
  const remainingArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === LOCAL_FLAG) {
      local = true;
      continue;
    }
    if (argument === TRANSPORT_FLAG) {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${TRANSPORT_FLAG} needs a value`);
      }
      transport = value;
      index += 1;
      continue;
    }
    remainingArgs.push(argument);
  }
  return { transport, local, remainingArgs };
}

async function runMessageStatusOverTransport(
  client: TransportClient,
  args: readonly string[],
): Promise<number> {
  const response = await client.request(MESSAGE_STATUS_ROUTE_PATH, args);
  if (!response.ok) {
    process.stderr.write(
      `message-status: ${response.error?.message ?? "transport request failed"}\n`,
    );
    return MESSAGE_STATUS_EXIT.TransportUnavailable;
  }
  const result = response.result as MessageStatusRouteResult;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.exitCode;
}

@Command({
  name: "message-status",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MessageStatusCommand extends CommandRunner {
  private readonly deps: MessageStatusDeps | undefined;
  private readonly transportClient: TransportClient;

  constructor(deps?: MessageStatusDeps, transportClient?: TransportClient) {
    super();
    this.deps = deps;
    this.transportClient = transportClient ?? new TransportClient();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const { transport, local, remainingArgs } = parseMessageStatusArgs(passedParams);
    const mode = resolveTransportMode({ transport, local }, "message-status");
    process.exitCode =
      mode === "rest"
        ? await runMessageStatusOverTransport(this.transportClient, remainingArgs)
        : await runMessageStatus(remainingArgs, this.deps);
  }
}
