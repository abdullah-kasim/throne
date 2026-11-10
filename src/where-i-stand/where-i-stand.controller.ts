import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Body, Controller, Get, Header, HttpStatus, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import {
  archiveResponse,
  failedResponse,
  pageResponse,
  recordsResponse,
  saveRequest,
  saveResponse,
  type ArchiveResponse,
  type FailedResponse,
  type PageResponse,
  type RecordsResponse,
  type SaveResponse,
} from "../web-api-contract/where-i-stand.ts";
import { CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD } from "../web-listener/response-caching.ts";
import { validatedRequest, validatedResponse } from "../web-listener/validated-boundary.ts";
import { readTextFileIfPresent } from "./file-presence.ts";
import { SaveOutcome } from "./page-save.ts";
import { archivePathIn, pagePathIn } from "./page-store.ts";
import { realWhereIStandDependencies, saveChangeFromThePage, type SaveAnswer } from "./where-i-stand-runtime.ts";

const RECORDS_FOLDER_NAME = "where-i-stand";
const RECORDS_FILE_NAME = "where-i-stand-prs.json";
const PAGE_IS_MISSING = "The page has not been written yet.";
const RECORDS_ARE_MISSING = "The pull request records have not been read yet.";

const STATUS_FOR_OUTCOME: Record<SaveResponse["outcome"], HttpStatus> = {
  [SaveOutcome.Saved]: HttpStatus.OK,
  [SaveOutcome.Unchanged]: HttpStatus.OK,
  [SaveOutcome.EntryChanged]: HttpStatus.CONFLICT,
  [SaveOutcome.EntryRepeated]: HttpStatus.CONFLICT,
  [SaveOutcome.LockHeld]: HttpStatus.CONFLICT,
  [SaveOutcome.FrameBroken]: HttpStatus.CONFLICT,
  [SaveOutcome.OutsideEpics]: HttpStatus.FORBIDDEN,
  [SaveOutcome.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

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
  return validatedResponse(failedResponse, { outcome: SaveOutcome.Failed, message });
}

function answerSave(response: Response, status: HttpStatus, answer: SaveAnswer): SaveResponse {
  response.status(status);
  return validatedResponse(saveResponse, answer);
}

@Controller("api/where-i-stand")
export class WhereIStandController {
  @Get("page")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async page(@Res({ passthrough: true }) response: Response): Promise<PageResponse | FailedResponse> {
    const page = await readFileAndItsTime(pagePathIn(resolveThroneHome()));
    if (page === undefined) return answerNotFound(response, PAGE_IS_MISSING);
    return validatedResponse(pageResponse, { markdown: page.text, lastModified: page.lastModified });
  }

  @Get("archive")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async archive(): Promise<ArchiveResponse> {
    const markdown = (await readTextFileIfPresent(archivePathIn(resolveThroneHome()))) ?? "";
    return validatedResponse(archiveResponse, { markdown });
  }

  @Get("records")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async records(@Res({ passthrough: true }) response: Response): Promise<RecordsResponse | FailedResponse> {
    const records = await readFileAndItsTime(recordsPath());
    if (records === undefined) return answerNotFound(response, RECORDS_ARE_MISSING);
    return validatedResponse(recordsResponse, { records: JSON.parse(records.text), lastModified: records.lastModified });
  }

  @Post("save")
  async save(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<SaveResponse> {
    const change = validatedRequest(saveRequest, body);
    const answer = await saveChangeFromThePage(change, realWhereIStandDependencies());
    return answerSave(response, STATUS_FOR_OUTCOME[answer.outcome], answer);
  }
}
