import type { z } from "zod";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import {
  archivedRowsResponse,
  purgeResponse,
  storedPage,
  structureListing,
  writeResponse,
  type WriterRequest,
} from "../web-api-contract/where-i-stand.ts";
import { webListenerAddress, webListenerPort } from "../web-listener/web-listener-address.ts";
import { WHERE_I_STAND_STORE_ROUTE } from "./where-i-stand-store.controller.ts";
import { WhereIStandStore, type WhereIStandOperations } from "./where-i-stand.store.ts";

export const LOCAL_FLAG = "--local";

export interface WhereIStandConnection {
  readonly operations: WhereIStandOperations;
  close(): Promise<void>;
}

export class BackendUnreachableError extends Error {
  constructor(address: string, cause: unknown) {
    super(
      `could not reach throne-backend at ${address} (${cause instanceof Error ? cause.message : String(cause)}); nothing was written. ` +
        `Start throne-backend, or run the command again with ${LOCAL_FLAG} to open the where-i-stand database in this process.`,
      { cause },
    );
    this.name = "BackendUnreachableError";
  }
}

function causeText(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

export function whereIStandOverRest(address: string = webListenerAddress(webListenerPort())): WhereIStandOperations {
  const base = `${address}/${WHERE_I_STAND_STORE_ROUTE}`;

  async function call<Schema extends z.ZodType>(schema: Schema, route: string, method = "GET", body?: unknown): Promise<z.output<Schema>> {
    let response: Response;
    try {
      response = await fetch(`${base}/${route}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new BackendUnreachableError(address, causeText(error));
    }
    const answer: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`throne-backend refused the request (${response.status}): ${JSON.stringify(answer)}`);
    }
    return schema.parse(answer);
  }

  const writerRoute = (route: string) => (id: string, request: WriterRequest) => call(writeResponse, route.replace(":id", encodeURIComponent(id)), "POST", request);

  return {
    listing: () => call(structureListing, "listing"),
    page: () => call(storedPage, "page"),
    archivedRows: (sectionId) => call(archivedRowsResponse, `sections/${encodeURIComponent(sectionId)}/archived-rows`),
    addRow: (request) => call(writeResponse, "rows", "POST", request),
    replaceRow: (rowId, request) => call(writeResponse, `rows/${encodeURIComponent(rowId)}`, "PUT", request),
    archiveRow: writerRoute("rows/:id/archive"),
    restoreRow: writerRoute("rows/:id/restore"),
    archiveSection: writerRoute("sections/:id/archive"),
    restoreSection: writerRoute("sections/:id/restore"),
    createTab: (request) => call(writeResponse, "tabs", "POST", request),
    createSection: (request) => call(writeResponse, "sections", "POST", request),
    purge: (request) => call(purgeResponse, "purge", "POST", request),
  };
}

export function connectToWhereIStand(options: { readonly local: boolean; readonly address?: string; readonly throneHome?: string }): WhereIStandConnection {
  if (!options.local) return { operations: whereIStandOverRest(options.address), close: async () => {} };
  const store = new WhereIStandStore(options.throneHome ?? resolveThroneHome());
  return { operations: store, close: () => store.onModuleDestroy() };
}
