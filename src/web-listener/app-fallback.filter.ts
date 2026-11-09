import { Catch, NotFoundException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD } from "./response-caching.ts";

const APP_ENTRY_FILE = "index.html";
const PAGE_READING_METHODS: readonly string[] = ["GET", "HEAD"];
const API_PATH = /^\/api(\/|$)/;

function asksForAnAppPage(request: Request): boolean {
  return PAGE_READING_METHODS.includes(request.method) && !API_PATH.test(request.path);
}

@Catch(NotFoundException)
export class AppFallbackFilter implements ExceptionFilter<NotFoundException> {
  constructor(private readonly webRoot: string) {}

  catch(exception: NotFoundException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    if (asksForAnAppPage(http.getRequest<Request>())) {
      response.setHeader(CACHE_CONTROL_HEADER, CHECKED_ON_EVERY_LOAD);
      response.sendFile(APP_ENTRY_FILE, { root: this.webRoot });
      return;
    }
    response.status(exception.getStatus()).json(exception.getResponse());
  }
}
