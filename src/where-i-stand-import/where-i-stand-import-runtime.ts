import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { WhereIStandStore } from "../where-i-stand-store/where-i-stand.store.ts";
import { differencesFromMarkdownPage } from "./compare-imported-page.ts";
import { importMarkdownPage } from "./import-markdown-page.ts";

export const WHERE_I_STAND_IMPORT_USAGE = [
  "usage: throne where-i-stand-import --page <page file> --archive <archive file> [--journal <journal file>]",
  "       throne where-i-stand-import --compare --page <page file>",
].join("\n");

const USAGE_EXIT = 2;
const DIFFERENT_EXIT = 1;

type Print = (line: string) => void;

async function comparedWithDatabase(throneHome: string, pageFile: string, print: Print): Promise<number> {
  const store = new WhereIStandStore(throneHome);
  try {
    const differences = differencesFromMarkdownPage(await readFile(pageFile, "utf8"), await store.page());
    if (differences.length === 0) {
      print(`The database shows the same entries under the same sections in the same order as ${pageFile}.`);
      return 0;
    }
    for (const difference of differences) print(difference);
    return DIFFERENT_EXIT;
  } finally {
    await store.onModuleDestroy();
  }
}

export async function runWhereIStandImport(
  commandArguments: readonly string[],
  throneHome: string = resolveThroneHome(),
  print: Print = (line) => console.log(line),
): Promise<number> {
  let values: { page?: string; archive?: string; journal?: string; compare?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...commandArguments],
      options: { page: { type: "string" }, archive: { type: "string" }, journal: { type: "string" }, compare: { type: "boolean" } },
    }));
  } catch (error) {
    print(`${error instanceof Error ? error.message : String(error)}\n${WHERE_I_STAND_IMPORT_USAGE}`);
    return USAGE_EXIT;
  }
  if (values.page === undefined || (!values.compare && values.archive === undefined)) {
    print(WHERE_I_STAND_IMPORT_USAGE);
    return USAGE_EXIT;
  }
  if (values.compare) return comparedWithDatabase(throneHome, values.page, print);
  const result = await importMarkdownPage(throneHome, { page: values.page, archive: values.archive!, journal: values.journal });
  print(
    result.imported
      ? `Imported ${result.liveRows} live rows and ${result.archivedRows} archived rows; the Markdown files were only read.`
      : "The page was imported before; nothing was changed.",
  );
  return 0;
}
