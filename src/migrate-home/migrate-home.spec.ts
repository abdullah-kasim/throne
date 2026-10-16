import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import {
  retiredSettingsDirectory,
  throneBrowserProfilesDirectory,
  throneConfigDirectory,
  throneLogsDirectory,
  resolveThroneHome,
} from "../shared-policy/throne-home.ts";
import {
  migrateThroneHome,
  MOVED_NOTE_FILE_NAME,
  type ThroneHomeMigrationReport,
  type ThroneHomeMigrationRequest,
} from "./migrate-home.ts";
import { retiredBrowserProfilesDirectory } from "./migrate-home-items.ts";

interface ScratchMachine {
  readonly request: ThroneHomeMigrationRequest;
  readonly oldSettings: string;
  readonly oldProfiles: string;
  readonly newConfig: string;
  readonly newProfiles: string;
  readonly checkoutRoot: string;
}

async function scratchMachine(choices: Partial<ThroneHomeMigrationRequest> = {}): Promise<ScratchMachine> {
  const root = await mkdtemp(path.join(os.tmpdir(), "migrate-home-"));
  const userHome = path.join(root, "user");
  const environment = { THRONE_DATA_HOME: path.join(root, "throne-home") };
  const checkoutRoot = path.join(root, "checkout");
  await mkdir(checkoutRoot, { recursive: true });
  return {
    request: {
      environment,
      userHome,
      checkoutRoot: undefined,
      backupDirectory: path.join(root, "backup"),
      keepOldCopies: false,
      leaveBrowserProfiles: false,
      ...choices,
    },
    oldSettings: retiredSettingsDirectory(userHome),
    oldProfiles: retiredBrowserProfilesDirectory(userHome),
    newConfig: throneConfigDirectory(environment),
    newProfiles: throneBrowserProfilesDirectory(environment),
    checkoutRoot,
  };
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function listTree(folder: string): Promise<Record<string, string>> {
  if (!(await pathExists(folder))) return {};
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return Object.fromEntries(files.map((file, index) => [path.relative(folder, file), contents[index]]));
}

function runAgainWithoutKeepingOldCopies(machine: ScratchMachine, backupSuffix: string): Promise<ThroneHomeMigrationReport> {
  return migrateThroneHome({
    ...machine.request,
    keepOldCopies: false,
    backupDirectory: `${machine.request.backupDirectory}-${backupSuffix}`,
  });
}

async function writeOldSettings(machine: ScratchMachine): Promise<void> {
  await writeText(path.join(machine.oldSettings, "features.json"), '{"flags":{}}\n');
  await writeText(path.join(machine.oldSettings, "private-refs.txt"), "secret-host\n");
  await writeText(path.join(machine.oldProfiles, "forge-example", "Default", "Cookies"), "cookie\n");
}

test("old settings are moved into the throne home and a MOVED.txt names the new places", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.equal(await readFile(path.join(machine.newConfig, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.equal(await readFile(path.join(machine.newConfig, "private-refs.txt"), "utf8"), "secret-host\n");
  assert.equal(await readFile(path.join(machine.newProfiles, "forge-example", "Default", "Cookies"), "utf8"), "cookie\n");
  assert.equal(await pathExists(path.join(machine.oldSettings, "features.json")), false);
  assert.equal(await pathExists(path.join(machine.oldProfiles, "forge-example")), false);
  const settingsNote = await readFile(path.join(machine.oldSettings, MOVED_NOTE_FILE_NAME), "utf8");
  assert.match(settingsNote, new RegExp(`features\\.json -> ${path.join(machine.newConfig, "features.json")}`));
  assert.match(settingsNote, new RegExp(`private-refs\\.txt -> ${path.join(machine.newConfig, "private-refs.txt")}`));
  const profilesNote = await readFile(path.join(machine.oldProfiles, MOVED_NOTE_FILE_NAME), "utf8");
  assert.match(profilesNote, new RegExp(`forge-example -> ${path.join(machine.newProfiles, "forge-example")}`));
});

test("a setting already in the throne home with different content is refused, its difference printed, and nothing changes", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);
  await writeText(path.join(machine.newConfig, "features.json"), '{"flags":{"other":true}}\n');

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, true);
  const refusal = report.lines.find((line) => line.startsWith("refused"));
  assert.match(refusal ?? "", /^-\{"flags":\{\}\}$/m);
  assert.match(refusal ?? "", /^\+\{"flags":\{"other":true\}\}$/m);
  assert.equal(await readFile(path.join(machine.oldSettings, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.equal(await readFile(path.join(machine.newConfig, "features.json"), "utf8"), '{"flags":{"other":true}}\n');
  assert.equal(await pathExists(path.join(machine.newConfig, "private-refs.txt")), true);
});

test("a setting already in the throne home with the same content is left alone", async () => {
  const machine = await scratchMachine({ keepOldCopies: true });
  await writeText(path.join(machine.oldSettings, "features.json"), "same\n");
  await writeText(path.join(machine.newConfig, "features.json"), "same\n");

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.ok(report.lines.some((line) => line.startsWith("already in place:")), report.lines.join("\n"));
  assert.equal(await readFile(path.join(machine.oldSettings, "features.json"), "utf8"), "same\n");
  assert.equal(report.backupDirectory, undefined);
});

test("running the migration twice changes nothing the second time", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);
  await migrateThroneHome(machine.request);
  const homeAfterFirstRun = await listTree(machine.request.environment.THRONE_DATA_HOME as string);
  const oldAfterFirstRun = await listTree(machine.oldSettings);
  const secondBackup = `${machine.request.backupDirectory}-second`;

  const report = await migrateThroneHome({ ...machine.request, backupDirectory: secondBackup });

  assert.equal(report.refused, false);
  assert.equal(report.backupDirectory, undefined);
  assert.equal(await pathExists(secondBackup), false);
  assert.deepEqual(await listTree(machine.request.environment.THRONE_DATA_HOME as string), homeAfterFirstRun);
  assert.deepEqual(await listTree(machine.oldSettings), oldAfterFirstRun);
});

test("everything the migration will touch is copied to the backup folder before anything moves", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);
  await writeText(path.join(machine.newConfig, "private-refs.txt"), "secret-host\n");

  const report = await migrateThroneHome(machine.request);

  const backup = machine.request.backupDirectory;
  assert.equal(report.backupDirectory, backup);
  assert.equal(await readFile(path.join(backup, machine.oldSettings, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.equal(await readFile(path.join(backup, machine.oldSettings, "private-refs.txt"), "utf8"), "secret-host\n");
  assert.equal(await readFile(path.join(backup, machine.newConfig, "private-refs.txt"), "utf8"), "secret-host\n");
  assert.equal(
    await readFile(path.join(backup, machine.oldProfiles, "forge-example", "Default", "Cookies"), "utf8"),
    "cookie\n",
  );
});

test("a browser profile that a running browser holds is not moved", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);
  const heldProfile = path.join(machine.oldProfiles, "held-example");
  await writeText(path.join(heldProfile, "Default", "Cookies"), "held\n");
  await symlink(`${os.hostname()}-${process.pid}`, path.join(heldProfile, "SingletonLock"));

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.ok(report.lines.some((line) => line.startsWith("held by a running browser") && line.includes(heldProfile)));
  assert.equal(await readFile(path.join(heldProfile, "Default", "Cookies"), "utf8"), "held\n");
  assert.equal(await pathExists(path.join(machine.newProfiles, "held-example")), false);
  assert.equal(await pathExists(path.join(machine.newProfiles, "forge-example")), true);
});

test("the checkout's config.user.ts moves only when asked", async () => {
  const machine = await scratchMachine();
  const checkoutConfig = path.join(machine.checkoutRoot, "config.user.ts");
  await writeText(checkoutConfig, "export default {};\n");

  await migrateThroneHome(machine.request);
  assert.equal(await pathExists(checkoutConfig), true);
  assert.equal(await pathExists(path.join(machine.newConfig, "config.user.ts")), false);

  const report = await migrateThroneHome({ ...machine.request, checkoutRoot: machine.checkoutRoot });

  assert.equal(report.refused, false);
  assert.equal(await pathExists(checkoutConfig), false);
  assert.equal(await readFile(path.join(machine.newConfig, "config.user.ts"), "utf8"), "export default {};\n");
  assert.match(await readFile(path.join(machine.checkoutRoot, MOVED_NOTE_FILE_NAME), "utf8"), /config\.user\.ts -> /);
});

test("a config.user.ts placed in the throne home is marked as an ES module so node loads it quietly", async () => {
  const machine = await scratchMachine({ keepOldCopies: true });
  await writeText(path.join(machine.checkoutRoot, "config.user.ts"), "export default {};\n");

  await migrateThroneHome({ ...machine.request, checkoutRoot: machine.checkoutRoot });

  const modulePackage = JSON.parse(await readFile(path.join(machine.newConfig, "package.json"), "utf8")) as { type?: string };
  assert.equal(modulePackage.type, "module");
});

test("browser profiles stay where they are when the migration is told to leave them", async () => {
  const machine = await scratchMachine({ leaveBrowserProfiles: true });
  await writeOldSettings(machine);

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.equal(await readFile(path.join(machine.oldProfiles, "forge-example", "Default", "Cookies"), "utf8"), "cookie\n");
  assert.equal(await pathExists(path.join(machine.newProfiles, "forge-example")), false);
  assert.equal(await pathExists(path.join(machine.oldProfiles, MOVED_NOTE_FILE_NAME)), false);
  assert.equal(await pathExists(path.join(machine.newConfig, "features.json")), true);
});

test("in keep-old mode settings are copied into the throne home and the old files stay readable", async () => {
  const machine = await scratchMachine({ keepOldCopies: true });
  await writeOldSettings(machine);

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.equal(await readFile(path.join(machine.oldSettings, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.equal(await readFile(path.join(machine.newConfig, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.equal(await readFile(path.join(machine.oldProfiles, "forge-example", "Default", "Cookies"), "utf8"), "cookie\n");
  assert.equal(await readFile(path.join(machine.newProfiles, "forge-example", "Default", "Cookies"), "utf8"), "cookie\n");
  assert.equal(await pathExists(path.join(machine.oldSettings, MOVED_NOTE_FILE_NAME)), false);
});

test("a later run finishes a copied setting by removing the identical old file and leaving MOVED.txt", async () => {
  const machine = await scratchMachine({ keepOldCopies: true });
  await writeOldSettings(machine);
  await migrateThroneHome(machine.request);

  const finishing = await runAgainWithoutKeepingOldCopies(machine, "finishing");

  assert.equal(finishing.refused, false);
  assert.equal(await pathExists(path.join(machine.oldSettings, "features.json")), false);
  assert.equal(await pathExists(path.join(machine.oldProfiles, "forge-example")), false);
  assert.equal(await readFile(path.join(machine.newConfig, "features.json"), "utf8"), '{"flags":{}}\n');
  assert.match(await readFile(path.join(machine.oldSettings, MOVED_NOTE_FILE_NAME), "utf8"), /features\.json -> /);
  const homeAfterFinishing = await listTree(machine.request.environment.THRONE_DATA_HOME as string);

  const third = await runAgainWithoutKeepingOldCopies(machine, "third");

  assert.equal(third.backupDirectory, undefined);
  assert.deepEqual(await listTree(machine.request.environment.THRONE_DATA_HOME as string), homeAfterFinishing);
});

test("the migration never touches logs, ledgers, queues, locks or worktrees", async () => {
  const machine = await scratchMachine();
  await writeOldSettings(machine);
  const throneHome = resolveThroneHome(machine.request.environment);
  const untouchable = {
    [path.join(throneLogsDirectory(machine.request.environment), "backend.log")]: "new log\n",
    [path.join(throneHome, "data", "alpha-example", "identity.md")]: "ledger\n",
    [path.join(throneHome, "regent-queue.sqlite")]: "queue\n",
    [path.join(throneHome, "state", "autoscale.lock")]: "lock\n",
    [path.join(throneHome, "worktrees", "repository", "branch", "file.ts")]: "worktree\n",
    [path.join(throneHome, "where-i-stand.md")]: "page\n",
    [path.join(machine.request.userHome, "Library", "Logs", "throne", "backend.log")]: "old log\n",
  };
  for (const [filePath, text] of Object.entries(untouchable)) await writeText(filePath, text);

  await migrateThroneHome(machine.request);

  for (const [filePath, text] of Object.entries(untouchable)) {
    assert.equal(await readFile(filePath, "utf8"), text, filePath);
  }
  const homeFolders = (await readdir(throneHome)).sort();
  assert.deepEqual(homeFolders, ["browser-profiles", "config", "data", "logs", "regent-queue.sqlite", "state", "where-i-stand.md", "worktrees"]);
});

test("an old settings folder that is a link to the throne home's config folder never loses the only copy", async () => {
  const machine = await scratchMachine();
  await writeText(path.join(machine.newConfig, "features.json"), "only copy\n");
  await mkdir(path.dirname(machine.oldSettings), { recursive: true });
  await symlink(machine.newConfig, machine.oldSettings);

  const report = await migrateThroneHome(machine.request);

  assert.equal(report.refused, false);
  assert.equal(await readFile(path.join(machine.newConfig, "features.json"), "utf8"), "only copy\n");
  assert.equal(await pathExists(path.join(machine.newConfig, MOVED_NOTE_FILE_NAME)), false);
});

test("a later run finishes a copied browser profile that carries a stale browser lock", async () => {
  const machine = await scratchMachine({ keepOldCopies: true });
  await writeOldSettings(machine);
  const profile = path.join(machine.oldProfiles, "forge-example");
  await symlink(`${os.hostname()}-2147483646`, path.join(profile, "SingletonLock"));
  await migrateThroneHome(machine.request);

  const finishing = await runAgainWithoutKeepingOldCopies(machine, "finishing");

  assert.equal(finishing.refused, false, finishing.lines.join("\n"));
  assert.equal(await pathExists(profile), false);
  assert.equal(await readFile(path.join(machine.newProfiles, "forge-example", "Default", "Cookies"), "utf8"), "cookie\n");
});
