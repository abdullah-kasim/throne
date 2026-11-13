import { parseNamingTheField } from "@contract/parse-naming-the-field.ts";
import { WEB_APP_MOUNT_PATH } from "@contract/web-app-mount.ts";
import type { z } from "zod";

export async function fetchParsed<Schema extends z.ZodType>(apiPath: string, schema: Schema): Promise<z.output<Schema>> {
  const response = await fetch(`${WEB_APP_MOUNT_PATH}/api/${apiPath}`);
  if (!response.ok) throw new Error(`${apiPath} answered ${response.status}`);
  return parseNamingTheField(schema, await response.json(), `${apiPath} response`);
}

export async function sendParsed<Schema extends z.ZodType>(apiPath: string, method: "POST" | "PUT", body: unknown, schema: Schema): Promise<z.output<Schema>> {
  const response = await fetch(`${WEB_APP_MOUNT_PATH}/api/${apiPath}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer: unknown = await response.json().catch(() => {
    throw new Error(`${apiPath} answered ${response.status}`);
  });
  return parseNamingTheField(schema, answer, `${apiPath} response`);
}
