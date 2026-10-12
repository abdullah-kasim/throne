import type { ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { readForgejoToken } from "./forgejo-site.ts";
import { forgejoApiUrl } from "./host-forge.ts";

const HTTP_NOT_FOUND = 404;

export interface ForgejoUpload {
  readonly fieldName: string;
  readonly fileName: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface ForgejoApi {
  readonly rootUrl: string;
  readonly token: string;
  readJson<T>(apiPath: string): Promise<T>;
  readJsonIfFound<T>(apiPath: string): Promise<T | undefined>;
  readText(apiPath: string): Promise<string>;
  sendJson<T>(method: string, apiPath: string, body: unknown): Promise<T>;
  sendJsonForText(method: string, apiPath: string, body: unknown): Promise<string>;
  remove(apiPath: string): Promise<void>;
  upload<T>(apiPath: string, file: ForgejoUpload): Promise<T>;
  download(url: string): Promise<Uint8Array<ArrayBuffer>>;
}

async function refusalFor(method: string, apiPath: string, response: Response): Promise<ForgeRefusal> {
  const detail = (await response.text()).trim().split("\n")[0] ?? "";
  return new ForgeRefusal(`Forgejo ${method} /api/v1/${apiPath} answered HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
}

export async function openForgejoApi(rootUrl: string, dependencies: ForgeDependencies): Promise<ForgejoApi> {
  const token = await readForgejoToken();
  const authorization = { Authorization: `token ${token}` };

  async function send(method: string, apiPath: string, init: RequestInit = {}): Promise<Response> {
    return dependencies.fetch(forgejoApiUrl(rootUrl, apiPath), {
      ...init,
      method,
      headers: { ...authorization, ...(init.headers as Record<string, string> | undefined) },
    });
  }

  async function sendOrRefuse(method: string, apiPath: string, init?: RequestInit): Promise<Response> {
    const response = await send(method, apiPath, init);
    if (!response.ok) throw await refusalFor(method, apiPath, response);
    return response;
  }

  function jsonRequest(body: unknown): RequestInit {
    return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
  }

  return {
    rootUrl,
    token,
    async readJson<T>(apiPath: string) {
      return (await (await sendOrRefuse("GET", apiPath)).json()) as T;
    },
    async readJsonIfFound<T>(apiPath: string) {
      const response = await send("GET", apiPath);
      if (response.status === HTTP_NOT_FOUND) return undefined;
      if (!response.ok) throw await refusalFor("GET", apiPath, response);
      return (await response.json()) as T;
    },
    async readText(apiPath: string) {
      return (await sendOrRefuse("GET", apiPath)).text();
    },
    async sendJson<T>(method: string, apiPath: string, body: unknown) {
      const text = await (await sendOrRefuse(method, apiPath, jsonRequest(body))).text();
      return (text.trim() === "" ? undefined : JSON.parse(text)) as T;
    },
    async sendJsonForText(method: string, apiPath: string, body: unknown) {
      return (await sendOrRefuse(method, apiPath, jsonRequest(body))).text();
    },
    async remove(apiPath: string) {
      await sendOrRefuse("DELETE", apiPath);
    },
    async upload<T>(apiPath: string, file: ForgejoUpload) {
      const form = new FormData();
      form.append(file.fieldName, new Blob([file.bytes]), file.fileName);
      return (await (await sendOrRefuse("POST", apiPath, { body: form })).json()) as T;
    },
    async download(url: string) {
      const response = await dependencies.fetch(url, { headers: authorization });
      if (!response.ok) throw new ForgeRefusal(`Forgejo GET ${url} answered HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
