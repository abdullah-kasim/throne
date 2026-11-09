import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import compression from "compression";
import type { NextFunction, Request, Response } from "express";
import { serveFolderPreviews } from "../previews/folder-preview-files.ts";
import { WEB_APP_MOUNT_PATH } from "../web-api-contract/web-app-mount.ts";
import { AppFallbackFilter } from "./app-fallback.filter.ts";
import { CACHE_CONTROL_HEADER, CACHED_FOR_GOOD, CHECKED_ON_EVERY_LOAD } from "./response-caching.ts";
import { FOLDER_PREVIEWS_PATH, WEB_LISTENER_HOST } from "./web-listener-address.ts";
import { WebListenerModule } from "./web-listener.module.ts";

export interface WebListenerOptions {
  readonly port: number;
  readonly webRoot: string;
  readonly configPath?: string;
}

const EVERY_BODY_TYPE = (): boolean => true;
const LARGEST_BODY = "16mb";
const HASHED_FILES_PATH = "/assets/";
const MOUNT_AT_THE_START_OF_A_URL = new RegExp(`^${WEB_APP_MOUNT_PATH}(?=[/?]|$)`);

function urlWithoutTheMount(url: string): string {
  const remainder = url.replace(MOUNT_AT_THE_START_OF_A_URL, "");
  return remainder.startsWith("/") ? remainder : `/${remainder}`;
}

function answerUnderTheMountToo(request: Request, _response: Response, next: NextFunction): void {
  request.url = urlWithoutTheMount(request.url);
  next();
}

function setResponseCaching(request: Request, response: Response, next: NextFunction): void {
  response.setHeader(CACHE_CONTROL_HEADER, request.path.startsWith(HASHED_FILES_PATH) ? CACHED_FOR_GOOD : CHECKED_ON_EVERY_LOAD);
  next();
}

export async function startWebListener(options: WebListenerOptions): Promise<NestExpressApplication> {
  const listener = await NestFactory.create<NestExpressApplication>(WebListenerModule, {
    abortOnError: false,
    bodyParser: false,
    logger: ["log", "warn", "error"],
  });
  listener.use(answerUnderTheMountToo);
  listener.use(FOLDER_PREVIEWS_PATH, serveFolderPreviews(options.configPath));
  listener.use(compression());
  listener.use(setResponseCaching);
  listener.useBodyParser("text", { type: EVERY_BODY_TYPE, limit: LARGEST_BODY });
  listener.useStaticAssets(options.webRoot);
  listener.useGlobalFilters(new AppFallbackFilter(options.webRoot));
  await listener.listen(options.port, WEB_LISTENER_HOST);
  return listener;
}
