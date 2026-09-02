import type { UsageCacheIo } from './telemetry-core/cache.ts';
import type { UsageLogRow } from './telemetry-core/log.ts';

export interface HttpJsonRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpJsonResponse {
  status: number;
  json: unknown;
}

export interface PlanUsageDeps {
  readCredentialsFile: () => Promise<string>;
  httpJson: (request: HttpJsonRequest) => Promise<HttpJsonResponse>;
  now: () => Date;
  out: (line: string) => void;
  errOut: (line: string) => void;
  cacheIo?: UsageCacheIo;
  appendUsageLog?: (rows: UsageLogRow[]) => Promise<void>;
  readUsageLog?: () => Promise<string>;
}
