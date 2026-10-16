import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveLiveThroneRoot } from "../throne-root-resolution.ts";
import { migrateThroneHome } from "./migrate-home.ts";

const KEEP_OLD_COPIES_OPTION = "keep-old-copies";

export const KEEP_OLD_COPIES_FLAG = `--${KEEP_OLD_COPIES_OPTION}`;

export const MIGRATE_HOME_USAGE = [
  "usage: throne migrate-home [--backup-dir <folder>] [--keep-old-copies] [--leave-browser-profiles] [--include-checkout-config]",
  "Moves the old settings and browser sign-ins into the throne home, backing up everything it touches first.",
  "  --backup-dir <folder>       where the backup goes (default: ~/tmp/throne-home-backup-<time>)",
  "  --keep-old-copies           copy into the throne home and leave the old files in place",
  "  --leave-browser-profiles    move no browser profile this run",
  "  --include-checkout-config   also move the live checkout's config.user.ts into the throne home",
  "Exits 1 when any item was refused because both copies exist and differ.",
].join("\n");

interface MigrateHomeArguments {
  readonly backupDirectory: string;
  readonly keepOldCopies: boolean;
  readonly leaveBrowserProfiles: boolean;
  readonly includeCheckoutConfig: boolean;
  readonly help: boolean;
}

function defaultBackupDirectory(userHome: string): string {
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(userHome, "tmp", `throne-home-backup-${time}`);
}

function parseMigrateHomeArguments(commandArguments: readonly string[], userHome: string): MigrateHomeArguments {
  const { values } = parseArgs({
    args: [...commandArguments],
    options: {
      "backup-dir": { type: "string" },
      [KEEP_OLD_COPIES_OPTION]: { type: "boolean", default: false },
      "leave-browser-profiles": { type: "boolean", default: false },
      "include-checkout-config": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    backupDirectory: path.resolve(values["backup-dir"] ?? defaultBackupDirectory(userHome)),
    keepOldCopies: values[KEEP_OLD_COPIES_OPTION],
    leaveBrowserProfiles: values["leave-browser-profiles"],
    includeCheckoutConfig: values["include-checkout-config"],
    help: values.help,
  };
}

export async function runMigrateHome(
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  userHome = os.homedir(),
): Promise<number> {
  let parsed: MigrateHomeArguments;
  try {
    parsed = parseMigrateHomeArguments(commandArguments, userHome);
  } catch (error) {
    process.stderr.write(`migrate-home: ${error instanceof Error ? error.message : String(error)}\n${MIGRATE_HOME_USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(`${MIGRATE_HOME_USAGE}\n`);
    return 0;
  }
  const report = await migrateThroneHome({
    environment,
    userHome,
    checkoutRoot: parsed.includeCheckoutConfig ? await resolveLiveThroneRoot() : undefined,
    backupDirectory: parsed.backupDirectory,
    keepOldCopies: parsed.keepOldCopies,
    leaveBrowserProfiles: parsed.leaveBrowserProfiles,
  });
  for (const line of report.lines) process.stdout.write(`migrate-home: ${line}\n`);
  if (report.backupDirectory !== undefined) {
    process.stdout.write(`migrate-home: backup written to ${report.backupDirectory}\n`);
  }
  return report.refused ? 1 : 0;
}
