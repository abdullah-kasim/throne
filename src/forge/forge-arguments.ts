export const FORGE_OPERATIONS = {
  status: { takesTarget: true, valueOptions: ["--repo"], required: [], flags: ["--json"] },
  "check-media-links": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: ["--json"] },
  open: { takesTarget: true, flagInsteadOfTarget: "--cleanup", valueOptions: ["--repo", "--editor"], required: [], flags: ["--print", "--cleanup"] },
  "ensure-repository": { takesTarget: false, valueOptions: ["--base", "--repo"], required: [], flags: [] },
  "push-branch": { takesTarget: false, valueOptions: ["--branch", "--base", "--repo"], required: ["--branch"], flags: [] },
  "pr create": {
    takesTarget: false,
    valueOptions: ["--title", "--body-file", "--base", "--head", "--repo"],
    required: ["--title", "--body-file", "--base", "--head"],
    flags: ["--draft", "--bypass"],
  },
  "pr view": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: ["--bypass"] },
  "pr edit": {
    takesTarget: true,
    valueOptions: ["--title", "--body-file", "--repo"],
    required: [],
    requiredOneOf: ["--title", "--body-file"],
    flags: ["--bypass"],
  },
  "pr list": { takesTarget: false, valueOptions: ["--limit", "--repo"], required: [], flags: ["--bypass"] },
  "pr diff": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: ["--bypass"] },
  "pr merge": { takesTarget: true, valueOptions: ["--repo"], required: ["--squash"], flags: ["--squash", "--bypass"] },
  "pr comment": { takesTarget: true, valueOptions: ["--body-file", "--repo"], required: ["--body-file"], flags: ["--bypass"] },
  "pr feedback": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  "pr review": { takesTarget: true, valueOptions: ["--comments-file", "--repo"], required: ["--comments-file"], flags: [] },
  "pr review-findings": { takesTarget: true, valueOptions: ["--out", "--repo"], required: ["--out"], flags: [] },
  "pr self-reviewed": { takesTarget: true, valueOptions: ["--head", "--repo"], required: ["--head"], flags: [] },
  "pr answer": {
    takesTarget: true,
    valueOptions: ["--comment", "--body-file", "--repo"],
    required: ["--comment", "--body-file"],
    flags: ["--resolve"],
  },
  promote: { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  land: { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  stage: { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  "mirror-feedback": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  "close-merged-twin": { takesTarget: true, valueOptions: ["--repo"], required: [], flags: [] },
  attach: { takesTarget: true, valueOptions: ["--file", "--repo"], required: ["--file"], flags: [] },
  detach: { takesTarget: true, valueOptions: ["--url", "--repo"], required: ["--url"], flags: [] },
  "render-markdown": { takesTarget: false, valueOptions: ["--file", "--repo"], required: ["--file"], flags: ["--bypass"] },
  "sync-branches": { takesTarget: false, valueOptions: ["--repo"], required: [], flags: [] },
} as const satisfies Record<
  string,
  {
    takesTarget: boolean;
    flagInsteadOfTarget?: string;
    requiredOneOf?: readonly string[];
    valueOptions: readonly string[];
    required: readonly string[];
    flags: readonly string[];
  }
>;

export type ForgeOperation = keyof typeof FORGE_OPERATIONS;

export interface ForgeInvocation {
  readonly operation: ForgeOperation;
  readonly target: string | undefined;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export const FORGE_USAGE = [
  "Usage: throne forge <operation> ...",
  "  status <number|url|branch> [--repo <path>] [--json]",
  "  check-media-links <pull request url> [--repo <path>] [--json]",
  "  open <number|url|branch> [--repo <path>] [--editor <cmd>] [--print]",
  "  open --cleanup [--repo <path>]",
  "  ensure-repository [--base <branch>] [--repo <path>]",
  "  push-branch --branch <name> [--base <branch>] [--repo <path>]",
  "  pr create --title <title> --body-file <path> --base <branch> --head <branch> [--draft] [--repo <path>] [--bypass]",
  "  pr view <number|url|branch> [--repo <path>] [--bypass]",
  "  pr edit <number|url|branch> [--title <title>] [--body-file <path>] [--repo <path>] [--bypass]",
  "  pr list [--limit <n>] [--repo <path>] [--bypass]",
  "  pr diff <number|url|branch> [--repo <path>] [--bypass]",
  "  pr merge <number|url|branch> --squash [--repo <path>] [--bypass]",
  "  pr comment <number|url|branch> --body-file <path> [--repo <path>] [--bypass]",
  "  pr feedback <number|url|branch> [--repo <path>]",
  "  pr review <forgejo url|staged github url> --comments-file <path> [--repo <path>]",
  "  pr review-findings <forgejo url|staged github url> --out <path> [--repo <path>]",
  "  pr self-reviewed <forgejo url|staged github url> --head <sha> [--repo <path>]",
  "  pr answer <number|url|branch> --comment <id> --body-file <path> [--resolve] [--repo <path>]",
  "  promote <number|url|branch> [--repo <path>]",
  "  land <number|url|branch> [--repo <path>]",
  "  stage <github pull request url> [--repo <path>]",
  "  mirror-feedback <number|url|branch> [--repo <path>]",
  "  close-merged-twin <number|url|branch> [--repo <path>]",
  "  attach <number|url|branch> --file <path> [--repo <path>]",
  "  detach <number|url|branch> --url <attachment url> [--repo <path>]",
  "  render-markdown --file <path> [--repo <path>] [--bypass]",
  "  sync-branches [--repo <path>]",
  "",
].join("\n");

function operationOf(args: readonly string[]): { operation: ForgeOperation; rest: readonly string[] } {
  const [first, second] = args;
  if (first === "pr" && second !== undefined && `pr ${second}` in FORGE_OPERATIONS) {
    return { operation: `pr ${second}` as ForgeOperation, rest: args.slice(2) };
  }
  if (first !== undefined && first !== "pr" && first in FORGE_OPERATIONS) {
    return { operation: first as ForgeOperation, rest: args.slice(1) };
  }
  throw new Error(`unknown operation "${args.slice(0, first === "pr" ? 2 : 1).join(" ")}"`);
}

export function parseForgeArguments(args: readonly string[]): ForgeInvocation {
  const { operation, rest } = operationOf(args);
  const spec = FORGE_OPERATIONS[operation];
  const valueOptions: readonly string[] = spec.valueOptions;
  const flagNames: readonly string[] = spec.flags;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let target: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (valueOptions.includes(token)) {
      const value = rest[index + 1];
      if (value === undefined || value === "") throw new Error(`${token} requires a value`);
      values.set(token, value);
      index += 1;
    } else if (flagNames.includes(token)) {
      flags.add(token);
    } else if (spec.takesTarget && target === undefined && !token.startsWith("-")) {
      target = token;
    } else {
      throw new Error(`unknown argument "${token}" for forge ${operation}`);
    }
  }
  const flagInsteadOfTarget = "flagInsteadOfTarget" in spec ? spec.flagInsteadOfTarget : undefined;
  const targetIsReplaced = flagInsteadOfTarget !== undefined && flags.has(flagInsteadOfTarget);
  if (targetIsReplaced && target !== undefined) throw new Error(`forge ${operation} ${flagInsteadOfTarget} takes no pull request, but was given "${target}"`);
  if (spec.takesTarget && !targetIsReplaced && target === undefined) {
    throw new Error(`forge ${operation} needs a pull request number, URL or branch`);
  }
  const missing = spec.required.filter((name: string) => !values.has(name) && !flags.has(name));
  if (missing.length > 0) throw new Error(`forge ${operation} requires ${missing.join(", ")}`);
  const oneOf: readonly string[] = "requiredOneOf" in spec ? spec.requiredOneOf : [];
  if (oneOf.length > 0 && !oneOf.some((name) => values.has(name))) throw new Error(`forge ${operation} requires ${oneOf.join(" or ")}`);
  for (const name of ["--limit", "--comment"]) {
    const number = values.get(name);
    if (number !== undefined && !/^[1-9]\d*$/.test(number)) throw new Error(`${name} must be a positive whole number, not "${number}"`);
  }
  return { operation, target, values, flags };
}
