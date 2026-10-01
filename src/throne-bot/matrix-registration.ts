import { randomBytes } from 'node:crypto';
import type { MatrixClient } from 'matrix-bot-sdk';

export interface MatrixRegistrationResult {
  userId: string;
  accessToken: string;
  deviceId: string;
}

interface RegisterUserResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

interface UiaaFlowBody {
  session?: string;
  flows?: unknown;
}

export async function registerMatrixBotUser(
  client: MatrixClient,
  localpart: string,
  registrationToken: string,
): Promise<MatrixRegistrationResult> {
  const password = randomBytes(32).toString('hex');
  let session: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body: Record<string, unknown> = {
      username: localpart,
      password,
      initial_device_display_name: 'throne-bot',
    };
    if (session !== undefined) {
      body.auth = {
        type: 'm.login.registration_token',
        token: registrationToken,
        session,
      };
    }
    try {
      const response = (await client.doRequest(
        'POST',
        '/_matrix/client/v3/register',
        { kind: 'user' },
        body,
      )) as RegisterUserResponse;
      return {
        userId: response.user_id,
        accessToken: response.access_token,
        deviceId: response.device_id,
      };
    } catch (error) {
      const flowBody = (error as { body?: UiaaFlowBody } | undefined)?.body;
      if (flowBody?.session !== undefined && flowBody.flows !== undefined) {
        session = flowBody.session;
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `registration for "${localpart}" did not complete after the registration-token stage`,
  );
}
