import path from "node:path";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { plainLinesOf, recordSpecArtefact, resolveSpecLocation, type Artefact, type Place, type SpecLocation } from "./spec-location.ts";

const SUCCESS = 0;
const FAILED = 1;
const REFUSED = 2;

export interface SpecLocationDependencies {
  readonly environment: NodeJS.ProcessEnv;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  "Usage: throne spec-location <repository> [--owned yes|no] [--place repository|data-home] [--record spec|map] [--json]\n" +
  "Prints where the repository's spec folder and feature map are, and the state of each:\n" +
  "none yet; in the throne data home; in the project, made with throne's tooling; in the project, made another way.\n" +
  "Settings live per project at <throne data home>/specs/<slug>/settings.json, keyed by the main checkout.\n" +
  "It never decides ownership: pass --owned when the settings do not record it yet.\n" +
  "--place picks where a repository that is ours keeps them; it defaults to the repository, and one that is not ours is always the data home.\n" +
  "--record writes the artefact's current place into the settings once it has been created.\n" +
  "--json prints the same fields as JSON.\n";

interface SpecLocationRequest {
  readonly repository: string;
  readonly owned?: boolean;
  readonly place?: Place;
  readonly record?: Artefact;
  readonly json: boolean;
}

function parseSpecLocationRequest(commandArguments: readonly string[]): SpecLocationRequest {
  let repository: string | undefined;
  let owned: boolean | undefined;
  let place: Place | undefined;
  let record: Artefact | undefined;
  let json = false;
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    const value = commandArguments[index + 1];
    if (argument === "--json") json = true;
    else if (argument === "--owned") {
      if (value !== "yes" && value !== "no") throw new Error("--owned takes yes or no");
      owned = value === "yes";
      index += 1;
    } else if (argument === "--place") {
      if (value !== "repository" && value !== "data-home") throw new Error("--place takes repository or data-home");
      place = value;
      index += 1;
    } else if (argument === "--record") {
      if (value !== "spec" && value !== "map") throw new Error("--record takes spec or map");
      record = value;
      index += 1;
    } else if (argument.startsWith("-")) throw new Error(`unknown flag "${argument}"`);
    else if (repository === undefined) repository = argument;
    else throw new Error(`unexpected argument "${argument}"`);
  }
  if (repository === undefined) throw new Error("name the repository");
  return { repository: path.resolve(repository), owned, place, record, json };
}

export async function runSpecLocation(
  commandArguments: readonly string[],
  dependencies: SpecLocationDependencies,
): Promise<number> {
  let request: SpecLocationRequest;
  try {
    request = parseSpecLocationRequest(commandArguments);
  } catch (error) {
    dependencies.writeStderr(`${USAGE}spec-location refused: ${error instanceof Error ? error.message : String(error)}\n`);
    return REFUSED;
  }
  const dataHome = resolveThroneHome(dependencies.environment);
  let location: SpecLocation;
  try {
    location =
      request.record === undefined
        ? await resolveSpecLocation(request.repository, dataHome, request.owned, request.place)
        : await recordSpecArtefact(request.repository, dataHome, request.record, request.owned, request.place);
  } catch (error) {
    dependencies.writeStderr(`spec-location: ${error instanceof Error ? error.message : String(error)}\n`);
    return FAILED;
  }
  dependencies.writeStdout(request.json ? `${JSON.stringify(location, null, 2)}\n` : `${plainLinesOf(location).join("\n")}\n`);
  return SUCCESS;
}
