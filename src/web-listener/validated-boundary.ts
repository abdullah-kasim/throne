import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import type { z } from "zod";
import { parseNamingTheField } from "../web-api-contract/parse-naming-the-field.ts";
import { failedResponse } from "../web-api-contract/where-i-stand.ts";

const BODY_IS_NOT_JSON = "request body is not JSON";

function refusedRequest(message: string): BadRequestException {
  return new BadRequestException(validatedResponse(failedResponse, { outcome: "failed", message }));
}

function jsonInBody(body: unknown): unknown {
  try {
    return JSON.parse(String(body));
  } catch {
    throw refusedRequest(BODY_IS_NOT_JSON);
  }
}

export function validatedRequest<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  return parseNamingTheField(schema, jsonInBody(body), "request", refusedRequest);
}

export function validatedResponse<Schema extends z.ZodType>(schema: Schema, value: z.input<Schema>): z.output<Schema> {
  return parseNamingTheField(schema, value, "response", (message) => new InternalServerErrorException(message));
}
