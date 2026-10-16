import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureComposerTimeoutDiagnostic } from "../src/herdr/herdr-composer-diagnostic-capture.ts";

const SETTINGS_DIALOG_SCREEN = "\u001b[1mSettings\u001b[0m\r\n  Status   Config   Usage\r\nEsc to cancel";
const SETTINGS_DIALOG_SCREEN_IN_OTHER_COLOURS =
  "\u001b[38;5;246mSettings\u001b[39m\r\n  \u001b[7mStatus\u001b[27m   Config   Usage\r\nEsc to cancel";
const WORKING_SCREEN = "\u001b[2mWorking on the next step\u001b[0m\r\n";
const FIRST_ATTEMPT_AT = Date.UTC(2026, 9, 13, 2, 0, 0);
const ONE_ATTEMPT_APART = 2_000;

async function withDiagnosticFolder(
  scenario: (
    capture: (recipientName: string, screen: string) => Promise<string | undefined>,
    capturesOnDisk: () => Promise<string[]>,
  ) => Promise<void>,
): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "composer-timeout-captures-"));
  let attempts = 0;
  const attemptTime = (): number => FIRST_ATTEMPT_AT + ONE_ATTEMPT_APART * attempts++;
  try {
    await scenario(
      (recipientName, screen) =>
        captureComposerTimeoutDiagnostic(recipientName, screen, attemptTime, folder),
      async () => (await readdir(folder)).sort().map((fileName) => path.join(folder, fileName)),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("a capture identical to the recipient's newest one is not written again and the existing file is named", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const firstPath = await capture("regent", SETTINGS_DIALOG_SCREEN);
    const repeatedPath = await capture("regent", SETTINGS_DIALOG_SCREEN);

    assert.equal(repeatedPath, firstPath);
    assert.deepEqual(await capturesOnDisk(), [firstPath]);
    assert.equal(await readFile(firstPath as string, "utf8"), SETTINGS_DIALOG_SCREEN);
  });
});

test("a capture that differs only in its ANSI codes counts as identical", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const firstPath = await capture("regent", SETTINGS_DIALOG_SCREEN);
    const recolouredPath = await capture("regent", SETTINGS_DIALOG_SCREEN_IN_OTHER_COLOURS);

    assert.equal(recolouredPath, firstPath);
    assert.deepEqual(await capturesOnDisk(), [firstPath]);
    assert.equal(await readFile(firstPath as string, "utf8"), SETTINGS_DIALOG_SCREEN);
  });
});

test("a capture that differs from the recipient's newest one is written", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const firstPath = await capture("regent", SETTINGS_DIALOG_SCREEN);
    const differentPath = await capture("regent", WORKING_SCREEN);

    assert.notEqual(differentPath, firstPath);
    assert.deepEqual(await capturesOnDisk(), [firstPath, differentPath]);
    assert.equal(await readFile(differentPath as string, "utf8"), WORKING_SCREEN);
  });
});

test("a screen the recipient showed before its newest capture is written again", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const firstPath = await capture("regent", SETTINGS_DIALOG_SCREEN);
    const secondPath = await capture("regent", WORKING_SCREEN);
    const thirdPath = await capture("regent", SETTINGS_DIALOG_SCREEN);

    assert.deepEqual(await capturesOnDisk(), [firstPath, secondPath, thirdPath]);
    assert.equal(new Set([firstPath, secondPath, thirdPath]).size, 3);
  });
});

test("another recipient's capture is never the comparison", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const regentPath = await capture("regent", SETTINGS_DIALOG_SCREEN);
    const otherRecipientPath = await capture("x-regent", WORKING_SCREEN);
    const regentWorkingPath = await capture("regent", WORKING_SCREEN);
    const otherRecipientDialogPath = await capture("x-regent", SETTINGS_DIALOG_SCREEN);

    assert.deepEqual(await capturesOnDisk(), [
      regentPath,
      otherRecipientPath,
      regentWorkingPath,
      otherRecipientDialogPath,
    ]);
    assert.equal(path.basename(regentWorkingPath as string).endsWith("Z-regent.ansi"), true);
    assert.equal(path.basename(otherRecipientDialogPath as string).endsWith("Z-x-regent.ansi"), true);
  });
});

test("a recipient with no capture yet gets its first one written", async () => {
  await withDiagnosticFolder(async (capture, capturesOnDisk) => {
    const firstPath = await capture("regent", SETTINGS_DIALOG_SCREEN);

    assert.equal(path.basename(firstPath as string), "2026-10-13T02-00-00-000Z-regent.ansi");
    assert.deepEqual(await capturesOnDisk(), [firstPath]);
    assert.equal(await readFile(firstPath as string, "utf8"), SETTINGS_DIALOG_SCREEN);
  });
});
