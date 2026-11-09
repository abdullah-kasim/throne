import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadUserConfigFile, resolveUserConfigPath } from "../user-config-loader.ts";
import { parseNamingTheField } from "../web-api-contract/parse-naming-the-field.ts";
import { WEB_APP_MOUNT_PATH } from "../web-api-contract/web-app-mount.ts";
import { isSameTailnetPlace, placeOfPreview } from "../web-listener/tailnet-routes.ts";
import { OLD_WHERE_I_STAND_PATH, TAILNET_DEFAULT_HTTPS_PORT } from "../web-listener/web-listener-address.ts";
import { fileIsMissing } from "../where-i-stand/file-presence.ts";

const TAILNET_PATH_FORM = /^\/[a-z0-9][a-z0-9-]*$/;
const RESERVED_TAILNET_PATHS: readonly string[] = [WEB_APP_MOUNT_PATH, OLD_WHERE_I_STAND_PATH];
const ADDRESSES_ON_THIS_MACHINE: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];
const ADDRESS_TAILSCALE_CAN_SERVE = /^(?:https?|https\+insecure):\/\/[^/]+:\d+(?:\/|$)/;
const HOME_FOLDER_PREFIX = "~/";
const HIGHEST_PORT = 65535;

function isOnThisMachine(address: string): boolean {
  return URL.canParse(address) && ADDRESSES_ON_THIS_MACHINE.includes(new URL(address).hostname);
}

function withHomeFolderExpanded(folder: string): string {
  return folder.startsWith(HOME_FOLDER_PREFIX)
    ? path.join(os.homedir(), folder.slice(HOME_FOLDER_PREFIX.length))
    : folder;
}

const tailnetPath = z
  .string()
  .regex(TAILNET_PATH_FORM, "must be one slash and a name of lowercase letters, digits and dashes")
  .refine((value) => !RESERVED_TAILNET_PATHS.includes(value), "belongs to the throne's own pages");

const tailnetPort = z
  .number()
  .int()
  .min(1)
  .max(HIGHEST_PORT)
  .refine((value) => value !== TAILNET_DEFAULT_HTTPS_PORT, "is the port of the path entries; give a path or another port");

const localAddress = z
  .string()
  .refine(isOnThisMachine, "must be an address on this machine")
  .regex(ADDRESS_TAILSCALE_CAN_SERVE, "must start with http:// or https:// and name its port");

const localFolder = z
  .string()
  .transform(withHomeFolderExpanded)
  .refine(path.isAbsolute, "must be an absolute path or start with ~/");

type PreviewFields = Partial<Record<"path" | "port" | "address" | "folder", unknown>>;

function requireExactlyOne(
  entry: PreviewFields,
  first: keyof PreviewFields,
  second: keyof PreviewFields,
  context: z.RefinementCtx,
): void {
  if ((entry[first] === undefined) !== (entry[second] === undefined)) return;
  context.addIssue({ code: "custom", path: [first], message: `give exactly one of ${first} or ${second}` });
}

const previewEntry = z
  .strictObject({
    path: tailnetPath.optional(),
    port: tailnetPort.optional(),
    address: localAddress.optional(),
    folder: localFolder.optional(),
  })
  .superRefine((entry, context) => {
    requireExactlyOne(entry, "path", "port", context);
    requireExactlyOne(entry, "address", "folder", context);
  });

export type PreviewEntry = z.output<typeof previewEntry>;

const previewList = z.array(previewEntry).superRefine((entries, context) => {
  entries.forEach((entry, index) => {
    const place = placeOfPreview(entry);
    if (entries.slice(0, index).some((earlier) => isSameTailnetPlace(placeOfPreview(earlier), place))) {
      context.addIssue({ code: "custom", path: [index], message: "takes a place an earlier entry already has" });
    }
  });
});

export function parsePreviews(value: unknown, sourcePath: string): readonly PreviewEntry[] {
  return parseNamingTheField(previewList, value, `previews in ${sourcePath}`);
}

async function fileVersionIfPresent(file: string): Promise<string | undefined> {
  try {
    const { mtimeMs, size } = await stat(file);
    return `${mtimeMs}-${size}`;
  } catch (error) {
    if (fileIsMissing(error)) return undefined;
    throw error;
  }
}

export async function previewsFromConfig(configPath?: string): Promise<readonly PreviewEntry[]> {
  const resolvedPath = configPath ?? (await resolveUserConfigPath());
  const fileVersion = await fileVersionIfPresent(resolvedPath);
  if (fileVersion === undefined) return [];
  const file = await loadUserConfigFile(resolvedPath, fileVersion);
  return parsePreviews(file?.previews ?? [], resolvedPath);
}
