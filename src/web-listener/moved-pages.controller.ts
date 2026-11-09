import { Controller, Get, HttpStatus, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WEB_APP_MOUNT_PATH } from "../web-api-contract/web-app-mount.ts";
import { MOVED_WHERE_I_STAND_PATH, OLD_WHERE_I_STAND_PATH, queryOf } from "./web-listener-address.ts";

@Controller()
export class MovedPagesController {
  @Get(`${MOVED_WHERE_I_STAND_PATH}{/*rest}`)
  redirectToTheWhereIStandPage(@Req() request: Request, @Res() response: Response): void {
    response.redirect(
      HttpStatus.FOUND,
      `${WEB_APP_MOUNT_PATH}${OLD_WHERE_I_STAND_PATH}/${queryOf(request.url)}`,
    );
  }
}
