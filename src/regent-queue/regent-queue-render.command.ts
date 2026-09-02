import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner, Option } from "nest-commander";
import { RegentQueueItemStatus } from "./regent-queue-item-state.ts";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
  type RegentQueueRenderFilter,
} from "./regent-queue-render.ts";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const KNOWN_STATUSES: readonly string[] = Object.values(RegentQueueItemStatus);

interface RenderQueueCommandOptions {
  readonly status?: RegentQueueItemStatus[];
  readonly all?: boolean;
}

function parseStatusToken(token: string): RegentQueueItemStatus {
  if (!KNOWN_STATUSES.includes(token)) {
    throw new Error(`${renderEntranceRefusal({
      reason: `render-queue rejected unrecognized --status value "${token}"; expected one of ${KNOWN_STATUSES.join(", ")}.`,
      bypass: undefined,
      supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
    })}`);
  }
  return token as RegentQueueItemStatus;
}

/**
 * Builds the filter `renderRegentQueueAsMarkdown` applies from the command's raw parsed
 * flags. `--all` renders every status; one or more `--status` values renders exactly those;
 * neither flag renders the shared "live" default (`LIVE_QUEUE_ITEM_STATUSES`) so the bare
 * command answers "what still needs doing" rather than burying it under finished work.
 */
export function parseRenderQueueStatusFlags(
  flags: RenderQueueCommandOptions,
): RegentQueueRenderFilter {
  if (flags.all === true) {
    return {};
  }
  if (flags.status !== undefined && flags.status.length > 0) {
    return { statuses: flags.status };
  }
  return { statuses: LIVE_QUEUE_ITEM_STATUSES };
}

@Command({
  name: "render-queue",
  description: "Render the SQLite Regent queue store's current state as readable markdown.",
})
export class RegentQueueRenderCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  @Option({
    flags: "--status <status>",
    description:
      "Render only items in this status; repeatable to render a combination. One of " +
      `${KNOWN_STATUSES.join(", ")}. Default (no --status, no --all): ${LIVE_QUEUE_ITEM_STATUSES.join(" + ")}.`,
  })
  parseStatus(value: string, previous: RegentQueueItemStatus[] = []): RegentQueueItemStatus[] {
    return [...previous, parseStatusToken(value)];
  }

  @Option({
    flags: "--all",
    description: "Render every status, including complete and abandoned campaign history.",
  })
  parseAll(): boolean {
    return true;
  }

  async run(_passedParams: string[], options: RenderQueueCommandOptions = {}): Promise<void> {
    const store = openRegentQueueStore();
    try {
      const filter = parseRenderQueueStatusFlags(options);
      console.log(renderRegentQueueAsMarkdown(store.readAll(), filter));
    } finally {
      store.close();
    }
  }
}
