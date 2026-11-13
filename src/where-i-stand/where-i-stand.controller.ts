import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Controller, Get, Header, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { failedResponse, recordsResponse, type FailedResponse, type RecordsResponse } from "../web-api-contract/where-i-stand.ts";
import { CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD } from "../web-listener/response-caching.ts";
import { validatedResponse } from "../web-listener/validated-boundary.ts";
import { readTextFileIfPresent } from "./file-presence.ts";

const RECORDS_FOLDER_NAME = "where-i-stand";
const RECORDS_FILE_NAME = "where-i-stand-prs.json";
const RECORDS_ARE_MISSING = "The pull request records have not been read yet.";

interface FileAndItsTime {
  readonly text: string;
  readonly lastModified: string;
}

function recordsPath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, RECORDS_FOLDER_NAME, RECORDS_FILE_NAME);
}

async function readFileAndItsTime(file: string): Promise<FileAndItsTime | undefined> {
  const text = await readTextFileIfPresent(file);
  if (text === undefined) return undefined;
  return { text, lastModified: (await stat(file)).mtime.toISOString() };
}

function answerNotFound(response: Response, message: string): FailedResponse {
  response.status(HttpStatus.NOT_FOUND);
  return validatedResponse(failedResponse, { outcome: "failed", message });
}

@Controller("api/where-i-stand")
export class WhereIStandController {
  @Get("records")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async records(@Res({ passthrough: true }) response: Response): Promise<RecordsResponse | FailedResponse> {
    const records = await readFileAndItsTime(recordsPath());
    if (records === undefined) return answerNotFound(response, RECORDS_ARE_MISSING);
    return validatedResponse(recordsResponse, { records: JSON.parse(records.text), lastModified: records.lastModified });
  }
}
