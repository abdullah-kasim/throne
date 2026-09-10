import type {
  HttpJsonResponse,
  PlanUsageDeps,
} from './pipeline.types.ts';
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { PlanUsagePlatformService } from './plan-usage-platform.service.ts';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

interface OauthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

function parseCredentials(raw: string): OauthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Claude credentials file is not valid JSON');
  }
  const oauth = isJsonRecord(parsed) ? parsed.claudeAiOauth : undefined;
  if (!isJsonRecord(oauth)) {
    throw new Error('Claude credentials file has no claudeAiOauth object');
  }
  const { accessToken, refreshToken, expiresAt, scopes } = oauth;
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresAt !== 'number' ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new Error(
      'Claude credentials are missing an expected field (accessToken, refreshToken, expiresAt, scopes)',
    );
  }
  return { accessToken, refreshToken, expiresAt, scopes };
}

export class PlanUsageAuthenticationService {
  private readonly runtime: PlanUsageDeps;

  constructor(platform: PlanUsagePlatformService) {
    this.runtime = platform.runtime;
  }

  async fetchUsage(): Promise<Record<string, unknown>> {
    const credentials = await this.readCredentials();
    const accessToken = await this.resolveAccessToken(credentials);
    const response = await this.runtime.httpJson({
      method: 'GET',
      url: USAGE_ENDPOINT,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    return this.usageResponseBody(response);
  }

  private async readCredentials(): Promise<OauthCredentials> {
    let raw: string;
    try {
      raw = await this.runtime.readCredentialsFile();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read Claude credentials (${detail})`);
    }
    return parseCredentials(raw);
  }

  private async resolveAccessToken(credentials: OauthCredentials): Promise<string> {
    const expiresAt = new Date(credentials.expiresAt);
    if (expiresAt.getTime() > this.runtime.now().getTime()) {
      return credentials.accessToken;
    }
    throw new Error(
      `Claude access token expired at ${expiresAt.toISOString()}; the throne never refreshes it, because a refresh rotates the refresh token shared with every Claude Code session and logs them all out. Any Claude Code session refreshes it on its next request; until then the last-good usage numbers are served as stale.`,
    );
  }

  private usageResponseBody(response: HttpJsonResponse): Record<string, unknown> {
    if (response.status !== 200) {
      throw new Error(`Claude usage request failed (HTTP ${response.status})`);
    }
    if (!isJsonRecord(response.json)) {
      throw new Error('Claude usage response was not a JSON object');
    }
    return response.json;
  }
}
