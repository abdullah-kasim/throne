import path from "node:path";
import { parseArgs } from "node:util";
import { agentRegistrationExists } from "../agentdata/spawn-data-contracts.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { writeScratchPaneMarker, type ScratchPaneMarker } from "./scratch-pane-markers.ts";

const REGISTER_SUBCOMMAND = "register";
const SUCCESS = 0;
const REFUSED = 2;

export interface ScratchPaneRegistration {
  readonly paneId: string;
  readonly owner: string;
  readonly until: Date;
}

export interface ScratchPaneDependencies {
  readonly environment: NodeJS.ProcessEnv;
  now(): Date;
  isKnownAgent(name: string): Promise<boolean>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: ScratchPaneDependencies = {
  environment: process.env,
  now: () => new Date(),
  isKnownAgent: (name) => agentRegistrationExists(name, path.join(resolveThroneHome(), "data")),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export const USAGE =
  "Usage: throne scratch-pane register <pane> --owner <agent> --until <ISO-8601 time>\n" +
  "Records that a live agent owns an unnamed herdr pane until a time, so the unnamed-agent sweep stays quiet\n" +
  "about it. After the time it reports the pane once as expired; when the owner is gone it reports it as orphaned.\n";

function parseUntil(value: string): Date {
  const until = new Date(value);
  if (Number.isNaN(until.getTime())) throw new Error(`--until "${value}" is not a time`);
  return until;
}

function parseScratchPaneRegistration(commandArguments: readonly string[]): ScratchPaneRegistration {
  const { values, positionals } = parseArgs({
    args: [...commandArguments],
    options: { owner: { type: "string" }, until: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const [subcommand, paneId, ...extra] = positionals;
  if (subcommand !== REGISTER_SUBCOMMAND) throw new Error(`the only subcommand is ${REGISTER_SUBCOMMAND}`);
  if (paneId === undefined) throw new Error("missing <pane>");
  if (extra.length > 0) throw new Error(`unexpected argument "${extra[0]}"`);
  if (values.owner === undefined) throw new Error("missing --owner");
  if (values.until === undefined) throw new Error("missing --until");
  return { paneId, owner: values.owner, until: parseUntil(values.until) };
}

export async function registerScratchPane(
  registration: ScratchPaneRegistration,
  dependencies: ScratchPaneDependencies,
): Promise<ScratchPaneMarker> {
  if (!(await dependencies.isKnownAgent(registration.owner))) {
    throw new Error(`"${registration.owner}" is not a known agent`);
  }
  if (registration.until.getTime() <= dependencies.now().getTime()) {
    throw new Error(`--until ${registration.until.toISOString()} has already passed`);
  }
  const marker: ScratchPaneMarker = {
    paneId: registration.paneId,
    owner: registration.owner,
    until: registration.until.toISOString(),
    reported: false,
  };
  await writeScratchPaneMarker(marker, dependencies.environment);
  return marker;
}

function refuseScratchPane(error: unknown, dependencies: ScratchPaneDependencies): number {
  dependencies.writeStderr(USAGE);
  dependencies.writeStderr(
    `${renderEntranceRefusal({
      reason: `scratch-pane refused: ${error instanceof Error ? error.message : String(error)}.`,
      bypass: undefined,
      supervisorRoute: "Name the pane, a known agent as its owner, and a future time.",
    })}\n`,
  );
  return REFUSED;
}

export async function runScratchPane(
  commandArguments: readonly string[],
  dependencies: ScratchPaneDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  try {
    const marker = await registerScratchPane(parseScratchPaneRegistration(commandArguments), dependencies);
    dependencies.writeStdout(`Registered scratch pane ${marker.paneId}, owner ${marker.owner}, until ${marker.until}.\n`);
    return SUCCESS;
  } catch (error) {
    return refuseScratchPane(error, dependencies);
  }
}
