import { HttpStatus } from "@nestjs/common";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { folderPreviewName } from "../web-listener/tailnet-routes.ts";
import { queryOf } from "../web-listener/web-listener-address.ts";
import { previewsFromConfig, type PreviewEntry } from "./preview-entries.ts";

const FOLDER_WITHOUT_ITS_CLOSING_SLASH = "EISDIR";
const FOLDER_ROOT = "./";

function closingSlashRedirect(preview: PreviewEntry, pathInFolder: readonly string[], request: Request): string {
  const lastName = pathInFolder.at(-1) ?? preview.path?.slice(1) ?? "";
  return `${encodeURIComponent(lastName)}/${queryOf(request.url)}`;
}

function answerWithFile(
  preview: PreviewEntry,
  folder: string,
  pathInFolder: readonly string[],
  request: Request,
  response: Response,
): void {
  const redirectToTheClosingSlash = (): void => {
    response.redirect(HttpStatus.FOUND, closingSlashRedirect(preview, pathInFolder, request));
  };
  if (pathInFolder.length === 0) {
    redirectToTheClosingSlash();
    return;
  }
  response.sendFile(pathInFolder.join("/") || FOLDER_ROOT, { root: folder }, (error) => {
    if (error === undefined || response.headersSent) return;
    if ((error as NodeJS.ErrnoException).code === FOLDER_WITHOUT_ITS_CLOSING_SLASH) {
      redirectToTheClosingSlash();
      return;
    }
    response.sendStatus(HttpStatus.NOT_FOUND);
  });
}

async function answerFolderPreview(configPath: string | undefined, request: Request, response: Response): Promise<void> {
  const [name, ...encodedPathInFolder] = request.path.slice(1).split("/");
  const previews = await previewsFromConfig(configPath);
  const preview = previews.find((entry) => entry.folder !== undefined && folderPreviewName(entry) === name);
  if (preview?.folder === undefined) {
    response.sendStatus(HttpStatus.NOT_FOUND);
    return;
  }
  answerWithFile(preview, preview.folder, encodedPathInFolder.map(decodeURIComponent), request, response);
}

export function serveFolderPreviews(configPath?: string): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    answerFolderPreview(configPath, request, response).catch(next);
  };
}
