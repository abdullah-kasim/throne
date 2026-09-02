import type {
  HttpJsonResponse,
  PlanUsageDeps,
} from './pipeline.types.ts';
function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { PlanUsagePlatformService } from './plan-usage-platform.service.ts';

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_SKEW_MS = 60_000;

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
    if (credentials.expiresAt - this.runtime.now().getTime() > REFRESH_SKEW_MS) {
      return credentials.accessToken;
    }
    const response = await this.runtime.httpJson({
      method: 'POST',
      url: TOKEN_ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: credentials.scopes.join(' '),
      }),
    });
    if (response.status !== 200) {
      throw new Error(`Claude token refresh failed (HTTP ${response.status})`);
    }
    const accessToken = isJsonRecord(response.json)
      ? response.json.access_token
      : undefined;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Claude token refresh returned no access_token');
    }
    return accessToken;
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
