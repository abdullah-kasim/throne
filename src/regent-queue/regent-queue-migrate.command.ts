import { existsSync } from "node:fs";
import path from "node:path";
import type { Command as CommanderCommand } from "commander";
import { Command, CommandRunner, Option } from "nest-commander";
import { REGENT_DIR } from "../regent-state/regent-state.service.ts";
import { openRegentQueueStore } from "./regent-queue.store.ts";
import {
  incrementallyImportQueueMarkdown,
  migrateQueueMarkdownToStore,
  QueueMigrationAlreadyRanError,
} from "./regent-queue-migrate.ts";

const QUEUE_MARKDOWN_PATH = path.join(REGENT_DIR, "QUEUE.md");
const QUEUE_ARCHIVE_MARKDOWN_PATH = path.join(REGENT_DIR, "QUEUE-ARCHIVE.md");

interface MigrateQueueMarkdownCommandOptions {
  readonly incremental?: boolean;
}

@Command({
  name: "migrate-queue-markdown",
  description:
    "Imports QUEUE.md (and its archive) into the SQLite Regent queue store: one-way by " +
    "default, or re-runnable/idempotent via --incremental.",
})
export class RegentQueueMigrateCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  @Option({
    flags: "--incremental",
    description:
      "Import only blocks not already present in the store (by content hash), safe to " +
      "re-run any number of times; does not require or interact with the one-way marker.",
  })
  parseIncremental(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options?: MigrateQueueMarkdownCommandOptions,
  ): Promise<void> {
    const archivePath = existsSync(QUEUE_ARCHIVE_MARKDOWN_PATH)
      ? QUEUE_ARCHIVE_MARKDOWN_PATH
      : undefined;
    const store = openRegentQueueStore();
    try {
      if (options?.incremental === true) {
        const report = incrementallyImportQueueMarkdown(QUEUE_MARKDOWN_PATH, archivePath, store);
        console.log(
          `Imported ${report.imported} new item(s); ${report.alreadyPresent} already present; ` +
            `store now has ${report.totalStoreRowCount} row(s).`,
        );
        for (const source of report.sources) {
          console.log(
            `  - ${source.path}: ${source.headingBlocks} heading block(s), ` +
              `${source.emojiBulletBlocks} emoji-bullet block(s), ${source.preambleBlocks} ` +
              `preamble block(s) — ${source.imported} imported, ${source.alreadyPresent} ` +
              "already present.",
          );
        }
        return;
      }

      const report = migrateQueueMarkdownToStore(QUEUE_MARKDOWN_PATH, archivePath, store);
      console.log(
        `Imported ${report.imported} item(s) from ${report.sourceFiles.join(", ")}; ` +
          `skipped ${report.skipped}.`,
      );
      if (report.skippedReasons.length > 0) {
        for (const reason of report.skippedReasons) console.log(`  - ${reason}`);
      }
    } catch (error) {
      if (error instanceof QueueMigrationAlreadyRanError) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    } finally {
      store.close();
    }
  }
}
