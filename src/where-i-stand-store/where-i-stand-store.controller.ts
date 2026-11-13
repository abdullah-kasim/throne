import { Body, Controller, Get, Header, HttpStatus, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  addRowRequest,
  archivedRowsResponse,
  createSectionRequest,
  createTabRequest,
  purgeRequest,
  purgeResponse,
  replaceRowRequest,
  storedPage,
  structureListing,
  writeResponse,
  writerRequest,
  type ArchivedRowsResponse,
  type PurgeResponse,
  type StoredPage,
  type StructureListing,
  type WriteResponse,
} from "../web-api-contract/where-i-stand.ts";
import { CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD } from "../web-listener/response-caching.ts";
import { validatedRequest, validatedResponse } from "../web-listener/validated-boundary.ts";
import { WhereIStandStore } from "./where-i-stand.store.ts";

export const WHERE_I_STAND_STORE_ROUTE = "api/where-i-stand/store";

function answerWrite(response: Response, answer: WriteResponse): WriteResponse {
  response.status(HttpStatus.OK);
  return validatedResponse(writeResponse, answer);
}

@Controller(WHERE_I_STAND_STORE_ROUTE)
export class WhereIStandStoreController {
  constructor(private readonly store: WhereIStandStore) {}

  @Get("listing")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async listing(): Promise<StructureListing> {
    return validatedResponse(structureListing, await this.store.listing());
  }

  @Get("page")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async page(): Promise<StoredPage> {
    return validatedResponse(storedPage, await this.store.page());
  }

  @Get("sections/:sectionId/archived-rows")
  @Header(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD)
  async archivedRows(@Param("sectionId") sectionId: string): Promise<ArchivedRowsResponse> {
    return validatedResponse(archivedRowsResponse, await this.store.archivedRows(sectionId));
  }

  @Post("rows")
  async addRow(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.addRow(validatedRequest(addRowRequest, body)));
  }

  @Put("rows/:rowId")
  async replaceRow(@Param("rowId") rowId: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.replaceRow(rowId, validatedRequest(replaceRowRequest, body)));
  }

  @Post("rows/:rowId/archive")
  async archiveRow(@Param("rowId") rowId: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.archiveRow(rowId, validatedRequest(writerRequest, body)));
  }

  @Post("rows/:rowId/restore")
  async restoreRow(@Param("rowId") rowId: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.restoreRow(rowId, validatedRequest(writerRequest, body)));
  }

  @Post("sections")
  async createSection(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.createSection(validatedRequest(createSectionRequest, body)));
  }

  @Post("sections/:sectionId/archive")
  async archiveSection(@Param("sectionId") sectionId: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.archiveSection(sectionId, validatedRequest(writerRequest, body)));
  }

  @Post("sections/:sectionId/restore")
  async restoreSection(@Param("sectionId") sectionId: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.restoreSection(sectionId, validatedRequest(writerRequest, body)));
  }

  @Post("tabs")
  async createTab(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<WriteResponse> {
    return answerWrite(response, await this.store.createTab(validatedRequest(createTabRequest, body)));
  }

  @Post("purge")
  async purge(@Body() body: unknown): Promise<PurgeResponse> {
    return validatedResponse(purgeResponse, await this.store.purge(validatedRequest(purgeRequest, body)));
  }
}
