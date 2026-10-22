const ACCOUNT_LINE_MARKER = "ACCOUNT:";
export const COMPANY_ACCOUNT = "company";

export type QueueRowAccount = typeof COMPANY_ACCOUNT;

type QueueRowAccountLine =
  | { readonly state: "absent" }
  | { readonly state: "company" }
  | { readonly state: "unknown"; readonly value: string };

const ACCOUNT_LINE = new RegExp(`^[ \\t]*${ACCOUNT_LINE_MARKER}[ \\t]*(.*?)[ \\t]*$`, "gm");

function readQueueRowAccountLine(body: string): QueueRowAccountLine {
  const values = [...body.matchAll(ACCOUNT_LINE)].map((match) => match[1] ?? "");
  const unknownValue = values.find((value) => value !== COMPANY_ACCOUNT);
  if (unknownValue !== undefined) return { state: "unknown", value: unknownValue };
  return values.length === 0 ? { state: "absent" } : { state: "company" };
}

export function queueRowAccountOf(body: string): QueueRowAccount | null {
  return readQueueRowAccountLine(body).state === "company" ? COMPANY_ACCOUNT : null;
}

export function accountLineFailureIn(body: string): string | undefined {
  const accountLine = readQueueRowAccountLine(body);
  return accountLine.state === "unknown" ? unknownAccountLineFailure(accountLine.value) : undefined;
}

function unknownAccountLineFailure(value: string): string {
  return (
    `${ACCOUNT_LINE_MARKER} line says "${value}", but the only accepted value is "${COMPANY_ACCOUNT}". ` +
    `Write "${ACCOUNT_LINE_MARKER} ${COMPANY_ACCOUNT}" only when the work needs an MCP server or a claude.ai connector; otherwise delete the line.`
  );
}
