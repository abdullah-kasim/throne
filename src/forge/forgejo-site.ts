import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  forgejoStateDirectory,
  isForgejoInstalledOnThisHost,
} from "../install-services/forgejo-installation.ts";
import { ForgeRefusal } from "./forge-refusal.ts";

const FORGEJO_APP_INI_PATH = path.join("config", "app.ini");
const FORGEJO_API_TOKEN_FILE_NAME = "api-token";

export interface ForgejoSite {
  readonly rootUrl: string;
}

function rootUrlSettingOf(appIni: string): string | undefined {
  const match = /^\s*ROOT_URL\s*=\s*(\S+)\s*$/m.exec(appIni);
  return match?.[1];
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function readForgejoSite(): Promise<ForgejoSite | undefined> {
  if (!(await isForgejoInstalledOnThisHost())) return undefined;
  const appIniPath = path.join(forgejoStateDirectory(), FORGEJO_APP_INI_PATH);
  let appIni: string;
  try {
    appIni = await readFile(appIniPath, "utf8");
  } catch {
    throw new ForgeRefusal(
      `Forgejo is installed on this host but ${appIniPath} cannot be read; re-run install-forgejo.sh from the live checkout.`,
    );
  }
  const rootUrl = rootUrlSettingOf(appIni);
  if (rootUrl === undefined) {
    throw new ForgeRefusal(`Forgejo is installed on this host but ${appIniPath} names no ROOT_URL; re-run install-forgejo.sh.`);
  }
  return { rootUrl: withTrailingSlash(rootUrl) };
}

export async function readForgejoToken(): Promise<string> {
  const tokenPath = path.join(forgejoStateDirectory(), FORGEJO_API_TOKEN_FILE_NAME);
  let token = "";
  try {
    token = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    token = "";
  }
  if (token === "") {
    throw new ForgeRefusal(
      `Forgejo is installed on this host but its API token ${tokenPath} is missing or empty; run install-forgejo.sh from the live checkout to create it.`,
    );
  }
  return token;
}
