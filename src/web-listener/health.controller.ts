import { Controller, Get } from "@nestjs/common";
import { healthResponse, type HealthResponse } from "../web-api-contract/health.ts";
import { validatedResponse } from "./validated-boundary.ts";

@Controller("api/health")
export class HealthController {
  @Get()
  health(): HealthResponse {
    return validatedResponse(healthResponse, { ok: true });
  }
}
