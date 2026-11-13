import { readFile } from "node:fs/promises";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import type { RowFields, StructureListing, WriteResponse } from "../web-api-contract/where-i-stand.ts";
import { BackendUnreachableError, connectToWhereIStand, type WhereIStandConnection } from "../where-i-stand-store/where-i-stand-client.ts";
import type { WhereIStandOperations } from "../where-i-stand-store/where-i-stand.store.ts";
import { sameName } from "../where-i-stand-store/where-i-stand-rules.ts";
import { workFieldsOf } from "./entry-text.ts";
import { renderListing, renderPageAsMarkdown } from "./page-as-markdown.ts";
import {
  parseWhereIStandArguments,
  WHERE_I_STAND_USAGE,
  WhereIStandAction,
  type EntryText,
  type SectionChoice,
  type WhereIStandArguments,
} from "./where-i-stand-arguments.ts";
import {
  isTheLordsName,
  JUST_HAPPENED,
  NOTHING_WAS_WRITTEN,
  renderBackendUnreachable,
  renderNameReservedForTheLord,
  renderNotAnId,
  renderNothingToRemove,
  renderSectionNameNotFound,
} from "./where-i-stand-messages.ts";

export const WhereIStandExitCode = {
  Done: 0,
  Refused: 1,
  InvalidInvocation: 2,
} as const;

export interface WhereIStandDependencies {
  readonly connect: (local: boolean) => WhereIStandConnection;
  readonly currentAgentName: () => Promise<string>;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export function realWhereIStandDependencies(): WhereIStandDependencies {
  return {
    connect: (local) => connectToWhereIStand({ local }),
    currentAgentName: resolveCurrentAgentName,
    out: (message) => void process.stdout.write(message),
    err: (message) => void process.stderr.write(message),
  };
}

type Change = Exclude<WhereIStandArguments, { action: typeof WhereIStandAction.List | typeof WhereIStandAction.Show }>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderInvalidInvocation(error: unknown): string {
  return `${messageOf(error)}\n${WHERE_I_STAND_USAGE}\n${renderEntranceRefusal({
    reason: "where-i-stand entrance validation refused this invocation; the page was not touched.",
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n`;
}

function renderCallerWithoutIdentity(error: unknown): string {
  return `${NOTHING_WAS_WRITTEN} ${renderEntranceRefusal({
    reason: `Only a caller with an agent identity may write the page, and this caller has none (${messageOf(error)}).`,
    bypass: undefined,
    supervisorRoute: "Run the command from your own agent pane, or ask your supervisor to make the edit.",
  })}\n`;
}

function report(answer: WriteResponse, dependencies: WhereIStandDependencies): number {
  if (answer.outcome === "done") {
    dependencies.out(`where-i-stand: ${answer.message}\n`);
    return WhereIStandExitCode.Done;
  }
  dependencies.err(`${NOTHING_WAS_WRITTEN} ${answer.message}\n${answer.listing === undefined ? "" : renderListing(answer.listing)}`);
  return WhereIStandExitCode.Refused;
}

function sectionNamed(listing: StructureListing, name: string) {
  const namesakes = listing.sections.filter((section) => section.parentId === null && sameName(section.name, name));
  return namesakes.find((section) => section.archivedAt === null) ?? namesakes[0];
}

async function entryTextOf(entry: EntryText): Promise<string> {
  return "text" in entry ? entry.text : readFile(entry.textFile, "utf8");
}

async function addByName(operations: WhereIStandOperations, writer: string, sectionName: string, row: RowFields, dependencies: WhereIStandDependencies): Promise<number> {
  const listing = await operations.listing();
  const section = sectionNamed(listing, sectionName);
  if (section === undefined) {
    dependencies.err(renderSectionNameNotFound(sectionName));
    return WhereIStandExitCode.Refused;
  }
  return report(await operations.addRow({ sectionId: section.id, listingToken: listing.listingToken, writer, row }), dependencies);
}

async function put(operations: WhereIStandOperations, writer: string, request: Extract<Change, { action: "put" }>, dependencies: WhereIStandDependencies): Promise<number> {
  if ("remove" in request) {
    const live = (await operations.page()).rows.find((row) => row.kind === "work" && row.code === request.code);
    if (live === undefined) {
      dependencies.err(renderNothingToRemove(request.code));
      return WhereIStandExitCode.Refused;
    }
    return report(await operations.archiveRow(live.id, { writer }), dependencies);
  }
  const row = workFieldsOf(request.code, await entryTextOf(request.entry));
  const section: SectionChoice = request.section;
  if ("sectionName" in section) {
    dependencies.err(renderSectionNameNotFound(section.sectionName));
    return WhereIStandExitCode.Refused;
  }
  return report(await operations.addRow({ sectionId: section.sectionId, listingToken: section.listingToken, writer, row }), dependencies);
}

async function archiveOrRestore(operations: WhereIStandOperations, writer: string, request: Extract<Change, { action: "archive" | "restore" }>, dependencies: WhereIStandDependencies): Promise<number> {
  const archiving = request.action === WhereIStandAction.Archive;
  if (/^r\d+$/.test(request.id)) {
    return report(await (archiving ? operations.archiveRow(request.id, { writer }) : operations.restoreRow(request.id, { writer })), dependencies);
  }
  if (/^s\d+$/.test(request.id)) {
    return report(await (archiving ? operations.archiveSection(request.id, { writer }) : operations.restoreSection(request.id, { writer })), dependencies);
  }
  dependencies.err(renderNotAnId(request.id));
  return WhereIStandExitCode.Refused;
}

async function change(operations: WhereIStandOperations, writer: string, request: Change, dependencies: WhereIStandDependencies): Promise<number> {
  switch (request.action) {
    case WhereIStandAction.Put:
      return put(operations, writer, request, dependencies);
    case WhereIStandAction.Note:
      return addByName(operations, writer, JUST_HAPPENED, { kind: "event", text: request.event }, dependencies);
    case WhereIStandAction.Archive:
    case WhereIStandAction.Restore:
      return archiveOrRestore(operations, writer, request, dependencies);
    case WhereIStandAction.Purge: {
      const answer = await operations.purge({ dryRun: request.dryRun, writer });
      dependencies.out(`where-i-stand: ${answer.message}\n${answer.purged.map((item) => `${item.item} ${item.words} (archived ${item.archivedAt})\n`).join("")}`);
      return WhereIStandExitCode.Done;
    }
    case WhereIStandAction.AddTab:
      return report(await operations.createTab({ name: request.name, listingToken: request.listingToken, writer }), dependencies);
    case WhereIStandAction.AddSection:
      return report(
        await operations.createSection({ tabId: request.tabId, parentId: request.parentId, name: request.name, listingToken: request.listingToken, writer }),
        dependencies,
      );
  }
}

async function writerOf(dependencies: WhereIStandDependencies): Promise<string | undefined> {
  let name: string;
  try {
    name = await dependencies.currentAgentName();
  } catch (error) {
    dependencies.err(renderCallerWithoutIdentity(error));
    return undefined;
  }
  if (!isTheLordsName(name)) return name;
  dependencies.err(renderNameReservedForTheLord(name));
  return undefined;
}

async function runAction(operations: WhereIStandOperations, request: WhereIStandArguments, dependencies: WhereIStandDependencies): Promise<number> {
  if (request.action === WhereIStandAction.List) {
    dependencies.out(renderListing(await operations.listing()));
    return WhereIStandExitCode.Done;
  }
  if (request.action === WhereIStandAction.Show) {
    dependencies.out(renderPageAsMarkdown(await operations.page()));
    return WhereIStandExitCode.Done;
  }
  const writer = await writerOf(dependencies);
  if (writer === undefined) return WhereIStandExitCode.Refused;
  return change(operations, writer, request, dependencies);
}

export async function runWhereIStand(
  commandArguments: readonly string[],
  dependencies: WhereIStandDependencies = realWhereIStandDependencies(),
): Promise<number> {
  let request: WhereIStandArguments;
  try {
    request = parseWhereIStandArguments(commandArguments);
  } catch (error) {
    dependencies.err(renderInvalidInvocation(error));
    return WhereIStandExitCode.InvalidInvocation;
  }
  const connection = dependencies.connect(request.local);
  try {
    return await runAction(connection.operations, request, dependencies);
  } catch (error) {
    dependencies.err(error instanceof BackendUnreachableError ? renderBackendUnreachable(error.message) : `${NOTHING_WAS_WRITTEN} ${messageOf(error)}\n`);
    return WhereIStandExitCode.Refused;
  } finally {
    await connection.close();
  }
}
