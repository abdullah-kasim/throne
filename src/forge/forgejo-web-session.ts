import { readFile } from "node:fs/promises";
import path from "node:path";
import { forgejoStateDirectory } from "../install-services/forgejo-installation.ts";
import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import type { ForgejoApi } from "./forgejo-api.ts";

const FORGEJO_ADMIN_PASSWORD_FILE_NAME = "admin-password";
const HTTP_SEE_OTHER = 303;

export interface ForgejoWebSession {
  readonly rootUrl: string;
  postForm(webPath: string, fields: Record<string, string>): Promise<Response>;
}

async function readAdminPassword(): Promise<string> {
  const passwordPath = path.join(forgejoStateDirectory(), FORGEJO_ADMIN_PASSWORD_FILE_NAME);
  let password = "";
  try {
    password = (await readFile(passwordPath, "utf8")).trim();
  } catch {
    password = "";
  }
  if (password === "") {
    throw new ForgeRefusal(
      `working in a Forgejo review conversation needs the admin's own sign-in, and ${passwordPath} is missing or empty; run install-forgejo.sh from the live checkout.`,
    );
  }
  return password;
}

function lastCookiePerName(response: Response): string {
  const cookies = new Map<string, string>();
  for (const setCookie of response.headers.getSetCookie()) {
    const pair = setCookie.split(";")[0]!;
    cookies.set(pair.split("=")[0]!.trim(), pair);
  }
  return [...cookies.values()].join("; ");
}

export async function signInToForgejoWebAsAdmin(api: ForgejoApi, dependencies: ForgeDependencies): Promise<ForgejoWebSession> {
  const administrator = await api.readJson<{ login: string }>("user");
  const response = await dependencies.fetch(`${api.rootUrl}user/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_name: administrator.login, password: await readAdminPassword() }).toString(),
  });
  const cookies = lastCookiePerName(response);
  if (response.status !== HTTP_SEE_OTHER || cookies === "") {
    throw new ForgeRefusal(`Forgejo refused the admin sign-in at ${api.rootUrl}user/login (HTTP ${response.status}).`);
  }
  return {
    rootUrl: api.rootUrl,
    postForm: (webPath, fields) =>
      dependencies.fetch(`${api.rootUrl}${webPath}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
        body: new URLSearchParams(fields).toString(),
      }),
  };
}
