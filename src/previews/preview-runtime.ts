import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { errorText } from "../shared-policy/error-text.ts";
import { withExclusiveFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { resolveUserConfigPath } from "../user-config-loader.ts";
import { productionTailnetPublishingDependencies } from "../web-listener/tailnet-publishing.hosted-worker.ts";
import {
  describeTailnetState,
  publishWantedTailnetRoutes,
  refusalToPublish,
  routeIsLive,
  type TailnetPublishingDependencies,
} from "../web-listener/tailnet-publishing.ts";
import { isSameTailnetPlace, placeOfPreview, routeOfPreview, type TailnetPlace } from "../web-listener/tailnet-routes.ts";
import { TAILNET_DEFAULT_HTTPS_PORT } from "../web-listener/web-listener-address.ts";
import { addPreviewToConfig, removePreviewFromConfig } from "./preview-config-edit.ts";
import { parsePreviews, previewsFromConfig, type PreviewEntry } from "./preview-entries.ts";

export const PREVIEW_USAGE = [
  "usage: throne preview add <path or port> --address <address on this machine>",
  "       throne preview add <path or port> --folder <folder>",
  "       throne preview remove <path or port>",
  "       throne preview list",
].join("\n");

const PreviewExitCode = { Done: 0, Refused: 1, InvalidInvocation: 2 } as const;
type PreviewExitCodeValue = (typeof PreviewExitCode)[keyof typeof PreviewExitCode];

const WHOLE_NUMBER = /^\d+$/;
const PREVIEWS_LIST_LOCK_NAME = "previews list";

export interface PreviewDependencies extends TailnetPublishingDependencies {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function productionPreviewDependencies(): PreviewDependencies {
  return {
    ...productionTailnetPublishingDependencies(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function placeFieldOf(placeArgument: string): { readonly port: number } | { readonly path: string } {
  return WHOLE_NUMBER.test(placeArgument) ? { port: Number(placeArgument) } : { path: placeArgument };
}

function placeOfArgument(placeArgument: string): TailnetPlace {
  return placeOfPreview(placeFieldOf(placeArgument));
}

function previewUrl(hostName: string, place: TailnetPlace): string {
  const port = place.httpsPort === TAILNET_DEFAULT_HTTPS_PORT ? "" : `:${place.httpsPort}`;
  return `https://${hostName}${port}${place.path}`;
}

async function withThePreviewsListHeld(
  { ledgerPath }: PreviewDependencies,
  changeTheList: () => Promise<PreviewExitCodeValue>,
): Promise<PreviewExitCodeValue> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  return withExclusiveFileLock(`${ledgerPath}.previews-list.lock`, PREVIEWS_LIST_LOCK_NAME, changeTheList);
}

async function addPreview(
  placeArgument: string,
  source: { readonly address?: string | undefined; readonly folder?: string | undefined },
  dependencies: PreviewDependencies,
  configPath: string,
): Promise<PreviewExitCodeValue> {
  const entry = { ...placeFieldOf(placeArgument), ...source };
  const previews = parsePreviews([...(await previewsFromConfig(configPath)), entry], configPath);
  const route = routeOfPreview(previews.at(-1) as PreviewEntry, dependencies.listenerPort);
  const refusal = await refusalToPublish(route, dependencies);
  if (refusal !== undefined) {
    dependencies.err(refusal);
    return PreviewExitCode.Refused;
  }
  await addPreviewToConfig(configPath, entry);
  await publishWantedTailnetRoutes({ ...dependencies, configPath });
  const { hostName } = await describeTailnetState(dependencies);
  dependencies.out(previewUrl(hostName, route));
  return PreviewExitCode.Done;
}

async function removePreview(
  placeArgument: string,
  dependencies: PreviewDependencies,
  configPath: string,
): Promise<PreviewExitCodeValue> {
  const place = placeOfArgument(placeArgument);
  const previews = await previewsFromConfig(configPath);
  const listPosition = previews.findIndex((entry) => isSameTailnetPlace(placeOfPreview(entry), place));
  if (listPosition === -1) {
    dependencies.err(`refused ${placeArgument}: it is not in the previews list, so this code does not own it; left alone`);
    return PreviewExitCode.Refused;
  }
  await removePreviewFromConfig(configPath, listPosition);
  await publishWantedTailnetRoutes({ ...dependencies, configPath });
  dependencies.out(`removed ${placeArgument}`);
  return PreviewExitCode.Done;
}

async function listPreviews(dependencies: PreviewDependencies, configPath: string): Promise<PreviewExitCodeValue> {
  const previews = await previewsFromConfig(configPath);
  const tailnetState = await describeTailnetState(dependencies);
  for (const preview of previews) {
    const route = routeOfPreview(preview, dependencies.listenerPort);
    const liveness = routeIsLive(route, tailnetState) ? "live" : "not live";
    dependencies.out(`${previewUrl(tailnetState.hostName, route)}\t${liveness}\t${preview.address ?? preview.folder}`);
  }
  return PreviewExitCode.Done;
}

function parsePreviewOptions(commandArguments: readonly string[]) {
  return parseArgs({
    args: [...commandArguments],
    allowPositionals: true,
    options: { address: { type: "string" }, folder: { type: "string" } },
  });
}

async function runParsedPreview(
  positionals: readonly string[],
  source: { readonly address?: string | undefined; readonly folder?: string | undefined },
  dependencies: PreviewDependencies,
): Promise<PreviewExitCodeValue> {
  const [action, placeArgument] = positionals;
  const configPath = dependencies.configPath ?? (await resolveUserConfigPath());
  if (action === "list" && placeArgument === undefined) return listPreviews(dependencies, configPath);
  if (action === "add" && placeArgument !== undefined) {
    return withThePreviewsListHeld(dependencies, () => addPreview(placeArgument, source, dependencies, configPath));
  }
  if (action === "remove" && placeArgument !== undefined) {
    return withThePreviewsListHeld(dependencies, () => removePreview(placeArgument, dependencies, configPath));
  }
  dependencies.err(PREVIEW_USAGE);
  return PreviewExitCode.InvalidInvocation;
}

export async function runPreview(
  commandArguments: readonly string[],
  dependencies: PreviewDependencies = productionPreviewDependencies(),
): Promise<number> {
  let parsed: ReturnType<typeof parsePreviewOptions>;
  try {
    parsed = parsePreviewOptions(commandArguments);
  } catch (error) {
    dependencies.err(`${errorText(error)}\n${PREVIEW_USAGE}`);
    return PreviewExitCode.InvalidInvocation;
  }
  try {
    return await runParsedPreview(parsed.positionals, parsed.values, dependencies);
  } catch (error) {
    dependencies.err(errorText(error));
    return PreviewExitCode.Refused;
  }
}
