// Requirement: the Claude usage sensor must find the OAuth credentials on
// macOS, where Claude Code keeps them in the login Keychain instead of
// `~/.claude/.credentials.json`. Observed 2026-09-07: the Regent's
// throttle-state sat at `status: "unavailable"` because the sensor only
// knew the file path. The read order is pinned: file first; Keychain only
// when the file is ENOENT and the platform is darwin; every other failure
// surfaces unchanged, and a double miss names both attempts.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAUDE_KEYCHAIN_SERVICE,
  readClaudeCredentialsRaw,
  type ClaudeCredentialSourceDeps,
} from "../src/plan-usage-remaining/claude-credential-source.ts";

const CREDS = '{"claudeAiOauth":{"accessToken":"x"}}';
const PATH = "/home/someone/.claude/.credentials.json";

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${PATH}'`);
  error.code = "ENOENT";
  return error;
}

function fakeDeps(overrides: Partial<ClaudeCredentialSourceDeps>) {
  const calls = { file: 0, keychain: [] as string[] };
  const deps: ClaudeCredentialSourceDeps = {
    platform: "darwin",
    readFile: async () => {
      calls.file += 1;
      throw enoent();
    },
    readKeychainItem: async (service) => {
      calls.keychain.push(service);
      return `${CREDS}\n`;
    },
    ...overrides,
  };
  return { deps, calls };
}

test("file present: returns the file and never consults the keychain", async () => {
  const { deps, calls } = fakeDeps({ readFile: async () => CREDS });
  assert.equal(await readClaudeCredentialsRaw(PATH, deps), CREDS);
  assert.deepEqual(calls.keychain, []);
});

test("file ENOENT on darwin: reads the Claude Code-credentials keychain item exactly once", async () => {
  const { deps, calls } = fakeDeps({});
  assert.equal(await readClaudeCredentialsRaw(PATH, deps), `${CREDS}\n`);
  assert.equal(calls.file, 1);
  assert.deepEqual(calls.keychain, [CLAUDE_KEYCHAIN_SERVICE]);
});

test("file ENOENT off darwin: rethrows ENOENT and never consults the keychain", async () => {
  const { deps, calls } = fakeDeps({ platform: "linux" });
  await assert.rejects(readClaudeCredentialsRaw(PATH, deps), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(calls.keychain, []);
});

test("non-ENOENT file error on darwin: rethrown as-is, keychain untouched", async () => {
  const eacces: NodeJS.ErrnoException = new Error("EACCES");
  eacces.code = "EACCES";
  const { deps, calls } = fakeDeps({ readFile: async () => { throw eacces; } });
  await assert.rejects(readClaudeCredentialsRaw(PATH, deps), (error: unknown) => error === eacces);
  assert.deepEqual(calls.keychain, []);
});

test("both miss: the error names the file attempt and the keychain attempt", async () => {
  const { deps } = fakeDeps({
    readKeychainItem: async () => { throw new Error("The specified item could not be found in the keychain."); },
  });
  await assert.rejects(readClaudeCredentialsRaw(PATH, deps), (error: Error) => {
    assert.match(error.message, /file \/home\/someone\/\.claude\/\.credentials\.json: ENOENT/);
    assert.match(error.message, /keychain "Claude Code-credentials": The specified item could not be found/);
    return true;
  });
});
