// Requirement: the Codex usage sensor must accept the current Codex CLI's
// `~/.codex/auth.json`, which no longer writes `auth_mode` and signals
// ChatGPT mode by a `tokens` object beside a null `OPENAI_API_KEY`.
// Observed 2026-09-07: the sensor rejected a valid login with
// `auth_mode "undefined", not "chatgpt"`. Legacy files that still carry
// `auth_mode: "chatgpt"` keep working; API-key mode is still refused.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAuthFile } from "../src/shared-policy/codex-usage.service.ts";

const TOKENS = { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acct" };

test("legacy auth_mode chatgpt is admitted", () => {
  assert.deepEqual(
    parseAuthFile(JSON.stringify({ auth_mode: "chatgpt", tokens: TOKENS })),
    { accessToken: "a", accountId: "acct" },
  );
});

test("current CLI shape (no auth_mode, tokens, null OPENAI_API_KEY) is admitted", () => {
  assert.deepEqual(
    parseAuthFile(JSON.stringify({ OPENAI_API_KEY: null, tokens: TOKENS, last_refresh: "2026-04-08T17:40:59Z" })),
    { accessToken: "a", accountId: "acct" },
  );
});

test("explicit apikey auth_mode is refused", () => {
  assert.throws(
    () => parseAuthFile(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" })),
    /auth_mode "apikey", not "chatgpt"/,
  );
});

test("no auth_mode, API key present, no tokens is refused as api-key mode", () => {
  assert.throws(
    () => parseAuthFile(JSON.stringify({ OPENAI_API_KEY: "sk-x" })),
    /auth_mode "apikey", not "chatgpt"/,
  );
});
