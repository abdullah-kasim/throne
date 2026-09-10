import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanUsageAuthenticationService } from "./plan-usage-authentication.service.ts";
import { PlanUsagePlatformService } from "./plan-usage-platform.service.ts";
import type { HttpJsonRequest, PlanUsageDeps } from "./pipeline.types.ts";

const NOW = new Date("2026-09-10T05:00:00.000Z");

function credentials(expiresAt: Date): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-token-under-test",
      refreshToken: "refresh-token-that-must-never-leave-the-store",
      expiresAt: expiresAt.getTime(),
      scopes: ["user:inference", "user:profile"],
    },
  });
}

function serviceWith(credentialJson: string) {
  const requests: HttpJsonRequest[] = [];
  const deps: PlanUsageDeps = {
    readCredentialsFile: async () => credentialJson,
    httpJson: async (request) => {
      requests.push(request);
      return { status: 200, json: { five_hour: { utilization: 10 } } };
    },
    now: () => NOW,
    out: () => {},
    errOut: () => {},
  };
  return {
    service: new PlanUsageAuthenticationService(new PlanUsagePlatformService(deps)),
    requests,
  };
}

test("an expired access token is an honest failure, never a refresh-token grant", async () => {
  const expired = new Date(NOW.getTime() - 60_000);
  const { service, requests } = serviceWith(credentials(expired));
  await assert.rejects(() => service.fetchUsage(), /expired at 2026-09-10T04:59:00\.000Z/);
  assert.equal(requests.length, 0, "no HTTP request may be made with an expired token");
});

test("a live access token is sent as a bearer to the usage endpoint and nothing else is called", async () => {
  const live = new Date(NOW.getTime() + 3_600_000);
  const { service, requests } = serviceWith(credentials(live));
  await service.fetchUsage();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.match(requests[0]?.url ?? "", /\/api\/oauth\/usage$/);
  assert.equal(requests[0]?.headers?.Authorization, "Bearer access-token-under-test");
  const everything = JSON.stringify(requests);
  assert.doesNotMatch(everything, /refresh-token-that-must-never-leave-the-store/);
  assert.doesNotMatch(everything, /oauth\/token/);
});
