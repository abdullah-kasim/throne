export const NOTHING_WAS_WRITTEN = "where-i-stand: refused, nothing was written.";

export const LORD_WRITER = "Lord";

export const JUST_HAPPENED = "Just happened";

export const IN_FLIGHT = "In flight";

export const DELIVERED_SECTIONS = ["Delivered, not on GitHub", "On GitHub"] as const;

export const PUT_BY_NAME = "\"throne where-i-stand list\" and then \"throne where-i-stand put --code <code> --section-id <id> --listing-token <token> --text-file <file>\"";

export function isTheLordsName(name: string): boolean {
  return name.trim().toLowerCase() === LORD_WRITER.toLowerCase();
}

export function renderNameReservedForTheLord(name: string): string {
  return `${NOTHING_WAS_WRITTEN} The writer name "${name}" belongs to the Lord's own changes from the page, so no agent may write under it.\n`;
}

export function renderSectionNameNotFound(name: string): string {
  return `${NOTHING_WAS_WRITTEN} put does not find a section by name, and "${name}" is a name. Run "throne where-i-stand list" and put with --section-id and --listing-token.\n`;
}

export function renderNothingToRemove(code: string): string {
  return `${NOTHING_WAS_WRITTEN} No live work entry holds ${code}, so there is nothing to archive.\n`;
}

export function renderNotAnId(id: string): string {
  return `${NOTHING_WAS_WRITTEN} "${id}" is neither a row id (such as r12) nor a section id (such as s3); "throne where-i-stand list" and "show" print them.\n`;
}

export function renderBackendUnreachable(message: string): string {
  return `where-i-stand: ${message}\n`;
}
