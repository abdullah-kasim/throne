import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import { canonicalizeIdentityRole } from "../shared-policy/identity-role-casing.ts";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";
import { containsSupervisionPollingLoop } from "./identity-polling.ts";
import { formatReapabilityClaim } from "../reap-agent/reapability-claim.ts";

export interface AgentIdentity {
  supervisor: string;
  escalation: string;
  role: string;
  policyOverride?: string;
  objectiveCode?: string;
  nonCampaign?: true;
  emptyWorktree?: true;
  /** The exact herdr tab label this agent was spawned with (persona-aware
   *  under a non-Default preset, canonical otherwise). Durable so restart
   *  recovery never has to reconstruct "which preset was active at spawn
   *  time" — it just reads what actually happened. Absent for a resumed
   *  agent, which never gets a fresh spawn-time label. */
  spawnedTabLabel?: string;
}

const ROLE_LINE_PREFIX = "- **Role:** ";
export const SUPERVISOR_LINE_PREFIX = "- **Supervisor (routine):** ";
export const SPAWNED_TAB_LABEL_LINE_PREFIX = "- **Spawned tab label:** ";

const NEVER_ASK_ADDRESSEE_INSTRUCTION =
  `You never put a question to the ${PERSONA_CONFIG.addressTitle} — decisions ` +
  `are yours (or your supervisor's) to make.`;

/** The Stager role's entire point is asking the addressee questions, so it
 *  gets the one standing exception to `NEVER_ASK_ADDRESSEE_INSTRUCTION` —
 *  reversed, not omitted, so a Stager's identity record states its own
 *  divergence explicitly instead of leaving it implied by absence. */
const STAGER_ASK_ADDRESSEE_INSTRUCTION =
  `Unlike every other role in the court, asking the ${PERSONA_CONFIG.addressTitle} ` +
  `questions directly IS your job — the standing never-ask-the-` +
  `${PERSONA_CONFIG.addressTitle} rule is reversed for you alone.`;

export function identityText(name: string, identity: AgentIdentity): string {
  const addresseeInstruction =
    identity.role === "Stager"
      ? STAGER_ASK_ADDRESSEE_INSTRUCTION
      : NEVER_ASK_ADDRESSEE_INSTRUCTION;
  const chainOfCommand =
    `You are \`${name}\` (${identity.role}). Your supervisor is ` +
    `\`${identity.supervisor}\` (routine questions/progress). Your escalation ` +
    `for genuine blockers is \`${identity.escalation}\`. Message either via ` +
    `\`throne send-agent <target> <message>\`. The \`throne\` command is on ` +
    `your PATH, so run it from wherever you are: STAY IN YOUR OWN cwd and ` +
    `never \`cd\` into the live throne root to reach the CLI. Editing or ` +
    `committing there instead of in your own worktree bypasses campaign ` +
    `isolation and the terminal gate chain. ${addresseeInstruction}`;
  const sections = [chainOfCommand];
  if (identity.policyOverride !== undefined) {
    sections.push(
      `Policy override for \`${name}\`: ${identity.policyOverride}`,
    );
  }
  sections.push(PERSONA_CONFIG.roleplayPrompt);
  return sections.join("\n\n");
}

const ROLE_STANDING_INSTRUCTION: Record<string, string> = {
  Alpha:
    "Execute your objective by running `/write-and-execute-todos` — plan a todo " +
    "bundle and run it end-to-end. The skill is throne-owned; if " +
    "`/write-and-execute-todos` does not resolve by name (e.g. a cross-repo " +
    `${PERSONA_CONFIG.campaignTitle} where your cwd is the target repo, not the ` +
    `${PERSONA_CONFIG.throneTitle.toLowerCase()}), read and ` +
    "follow `.claude/skills/write-and-execute-todos/SKILL.md` under the live " +
    `throne root. Inside the ${PERSONA_CONFIG.throneTitle.toLowerCase()}, running it means YOU spawn ` +
    `a real ${PERSONA_CONFIG.tierTitles.shadow} yourself (via \`create-agent --role Shadow\`, its own herdr tab ` +
    `+ worktree) per slice — the ${PERSONA_CONFIG.tierTitles.regent} never spawns your ${PERSONA_CONFIG.tierTitles.shadow}s for you and ` +
    `you must never wait on it to. Each ${PERSONA_CONFIG.tierTitles.shadow}'s DONE or blocker ` +
    "`send-agent` message is an immediate supervision event and your primary wake-up path. " +
    "When no work is dependency-ready, become idle: schedule no sleep, status query, or " +
    "follow-up model turn. Use `agent-logs` only for one completion review, an explicit " +
    "blocker, or silence beyond the 30-minute Regent heartbeat interval; never use " +
    "`agent-statuses` as a short-cadence substitute. Merge completed work with " +
    "`merge-git-tree`, and reap it when done. The buck stops with you " +
    `as the ${PERSONA_CONFIG.campaignTitle} technical lead and owner of its outcome: research ambiguity ` +
    "and use evidence plus the safest defensible best-effort assumptions to decide " +
    "architecture, implementation, scope, and trade-offs. Actively supervise your " +
    `${PERSONA_CONFIG.tierTitles.shadow}s and own their integration and verification. Communicate decisively, ` +
    "concisely, directly, and assertively: state the selected course, rationale, " +
    "assumptions, risks, precise unknowns, and results. Label uncertainty precisely " +
    "and never fabricate certainty. Do not ask the " +
    `${PERSONA_CONFIG.addressTitle} to choose routine engineering options, offer permission-seeking menus, ` +
    "or pad decisions with weak hedges. Escalate only genuine exhausted blockers, " +
    "naming the investigations and alternatives attempted, why each failed, and " +
    "the exact evidence or authority required to unblock. Report progress and completion to your " +
    `supervisor. Author your todo bundle and ALL ${PERSONA_CONFIG.campaignTitle}-specific working notes ` +
    `and artifacts inside the ${PERSONA_CONFIG.throneTitle.toLowerCase()} ledger at \`data/<your-agent-name>/\` — ` +
    "NEVER in the target repo and NEVER at the throne root. This holds for " +
    `cross-repo ${PERSONA_CONFIG.campaignTitle}s: the bundle stays in the ${PERSONA_CONFIG.throneTitle.toLowerCase()} ledger even when the ` +
    "code lives elsewhere. Durable cross-session learnings go to " +
    "`agent_docs/MEMORY/`, not the ledger. " +
    "When you end a turn idle because you are genuinely waiting on a specific " +
    "child, publish `{\"blocked\":true}` together with one `__BLOCKED_BY_<name>__` " +
    "token per child you are waiting on, in that same message -- naming the " +
    "child(ren) lets the no-idling sweep detect when every one of them no " +
    "longer resolves and wake you directly with a concrete message, instead " +
    "of leaving you parked on a condition that already cleared. " +
    "`reap-agent` will not tear you down without a live, recent, qualifying " +
    "JSON reapability claim -- this is a real precondition, not a formality, " +
    "and a finished campaign with a written REPORT.md is still refused " +
    "teardown without it. After you have told your supervisor you are done, " +
    "and -- for a campaign delivering to a git repository -- only after your " +
    "terminal delivery gate has PASSed, publish " +
    `\`${formatReapabilityClaim("completed")}\` as your latest message.`,
  Shadow:
    "When you end a turn idle because you are genuinely waiting on a specific " +
    "child, publish `{\"blocked\":true}` together with one `__BLOCKED_BY_<name>__` " +
    "token per child you are waiting on, in that same message -- naming the " +
    "child(ren) lets the no-idling sweep detect when every one of them no " +
    "longer resolves and wake you directly with a concrete message, instead " +
    "of leaving you parked on a condition that already cleared.",
  Stager:
    `Idle waiting on the ${PERSONA_CONFIG.addressTitle} is your NORMAL state, ` +
    "not a stall. You exist because the " +
    `${PERSONA_CONFIG.tierTitles.regent} is sometimes too busy to be the ` +
    `${PERSONA_CONFIG.addressTitle}'s first point of contact, and his ability ` +
    `to reach someone must never block on ${PERSONA_CONFIG.tierTitles.regent} ` +
    `load. You are the ${PERSONA_CONFIG.addressTitle}'s staging area: he talks ` +
    "to you directly, you help him form and solidify a plan, and you read " +
    `the ${PERSONA_CONFIG.tierTitles.regent}'s queue ONLY WHEN ASKED — ` +
    "never on your own initiative, never as a worklist you pull from. Once a " +
    `plan is consolidated, you RELAY it on the ${PERSONA_CONFIG.addressTitle}'s ` +
    "behalf: run `add-to-queue` (never rewrite or reorder existing entries), " +
    `then \`send-agent\` the ${PERSONA_CONFIG.tierTitles.regent} ` +
    "that a plan is complete and ask the " +
    `${PERSONA_CONFIG.tierTitles.regent} to launch the ${PERSONA_CONFIG.tierTitles.alpha}. ` +
    `You never launch an ${PERSONA_CONFIG.tierTitles.alpha} yourself — you relay ` +
    `and ask. You also talk to the ${PERSONA_CONFIG.addressTitle} directly and ` +
    "may ask him questions.",
};

export function roleStandingInstruction(role: string, name?: string): string {
  const instruction = ROLE_STANDING_INSTRUCTION[role] ?? "";
  if (instruction === "") {
    return "";
  }
  return instruction.replaceAll(
    "<your-agent-name>",
    name ?? "<your-agent-name>",
  );
}

export function composeOpeningPrompt(
  name: string,
  identity: AgentIdentity,
  extra?: string,
): string {
  const prompt = [
    identityText(name, identity),
    roleStandingInstruction(identity.role, name),
    extra ?? "",
  ]
    .filter((section) => section !== "")
    .join("\n\n");
  if (identity.role === "Alpha" && containsSupervisionPollingLoop(prompt)) {
    throw new Error(
      "Alpha instructions must not contain a shell loop that combines sleep with agent-logs or agent-statuses",
    );
  }
  return prompt;
}

const OPENING_PROMPT_BASENAME = "opening-prompt.md";

export function openingPromptPath(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): string {
  return path.join(baseDir, name, OPENING_PROMPT_BASENAME);
}

export function identityPath(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): string {
  return path.join(baseDir, name, "identity.md");
}

export function composeCodexOpeningPrompt(
  name: string,
  baseDir?: string,
): string {
  return (
    `Read and follow every instruction in \`${openingPromptPath(name, baseDir)}\` now, ` +
    `before any other action. Also read \`${identityPath(name, baseDir)}\`; it remains ` +
    "the authoritative identity record. Together these durable records contain " +
    `the registered identity and chain of command, ${PERSONA_CONFIG.campaignTitle} status or objective, ` +
    "every policy override, persona, role instructions, and the exact custom " +
    "assignment when one was provided."
  );
}

export async function writeOpeningPrompt(
  name: string,
  prompt: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<void> {
  const filePath = openingPromptPath(name, baseDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, prompt, "utf8");
}

export async function readOpeningPrompt(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<string | null> {
  try {
    return await readFile(openingPromptPath(name, baseDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function roleNameFor(role: string, name: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "" || normalized === "none") {
    return name;
  }
  const prefix = `${normalized}-`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

export async function writeIdentity(
  name: string,
  identity: AgentIdentity,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<void> {
  const dir = path.join(baseDir, name);
  await mkdir(dir, { recursive: true });
  // Canonicalize once, up front, so the durable Role line and every use of
  // `identity.role` below it (the identity text's own "You are ... (role)"
  // sentence, `roleStandingInstruction`'s lookup) agree with each other --
  // a caller passing a differently-cased but semantically identical role
  // (e.g. `--role alpha`) must never produce a written record that disagrees
  // with itself.
  const canonicalIdentity: AgentIdentity = {
    ...identity,
    role: canonicalizeIdentityRole(identity.role),
  };
  const body = [
    `# Identity — ${name}`,
    "",
    `${ROLE_LINE_PREFIX}${canonicalIdentity.role}`,
    `${SUPERVISOR_LINE_PREFIX}${canonicalIdentity.supervisor}`,
    `- **Escalation (blockers only):** ${canonicalIdentity.escalation}`,
    ...(canonicalIdentity.objectiveCode === undefined
      ? canonicalIdentity.nonCampaign === true
        ? ["- **Campaign status:** non-campaign"]
        : []
      : [`- **Campaign objective code:** ${canonicalIdentity.objectiveCode}`]),
    ...(canonicalIdentity.emptyWorktree === true
      ? ["- **Launch mode:** explicit empty-worktree (managed empty scratch)"]
      : []),
    ...(canonicalIdentity.spawnedTabLabel === undefined
      ? []
      : [`${SPAWNED_TAB_LABEL_LINE_PREFIX}${canonicalIdentity.spawnedTabLabel}`]),
    "",
    identityText(name, canonicalIdentity),
    "",
  ].join("\n");
  await writeFile(path.join(dir, "identity.md"), body, "utf8");
}

/**
 * The three distinguishable outcomes of reading one prefixed line out of an
 * agent's `identity.md`. An unresolvable read (any errno, corrupt or
 * partially written content) is never collapsed into the field-absent
 * outcome -- per `agent_docs/MEMORY/TRISTATE_UNKNOWN_IS_NEVER_EMPTY_LAW.md`,
 * "an unresolvable read is unknown; unknown is never empty, never absent."
 */
export const IdentityLineReadStatus = {
  Found: "found",
  FieldAbsent: "field-absent",
  ReadUnresolved: "read-unresolved",
} as const;
export type IdentityLineReadStatus =
  (typeof IdentityLineReadStatus)[keyof typeof IdentityLineReadStatus];

export type IdentityLineRead =
  | { status: (typeof IdentityLineReadStatus)["Found"]; value: string }
  | { status: (typeof IdentityLineReadStatus)["FieldAbsent"] }
  | {
      status: (typeof IdentityLineReadStatus)["ReadUnresolved"];
      error: unknown;
    };

async function readIdentityLine(
  name: string,
  prefix: string,
  baseDir: string,
): Promise<IdentityLineRead> {
  let body: string;
  try {
    body = await readFile(path.join(baseDir, name, "identity.md"), "utf8");
  } catch (error) {
    return { status: IdentityLineReadStatus.ReadUnresolved, error };
  }
  for (const line of body.split("\n")) {
    if (line.startsWith(prefix)) {
      return {
        status: IdentityLineReadStatus.Found,
        value: line.slice(prefix.length).trim(),
      };
    }
  }
  return { status: IdentityLineReadStatus.FieldAbsent };
}

export function readAgentRole(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<IdentityLineRead> {
  return readIdentityLine(name, ROLE_LINE_PREFIX, baseDir);
}

export function readAgentSupervisor(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<IdentityLineRead> {
  return readIdentityLine(name, SUPERVISOR_LINE_PREFIX, baseDir);
}

export function readSpawnedTabLabel(
  name: string,
  baseDir: string = DEFAULT_DATA_DIR,
): Promise<IdentityLineRead> {
  return readIdentityLine(name, SPAWNED_TAB_LABEL_LINE_PREFIX, baseDir);
}

/**
 * The field value a delivery-recording call site persists for one tristate
 * read: the found value, empty string for a genuinely absent field or a
 * missing read altogether, and an explicit sentinel for an unresolved read
 * so it never silently collapses into the absent-field string.
 */
export function identityFieldForRecording(
  read: IdentityLineRead | undefined,
): string {
  if (read === undefined) return "";
  switch (read.status) {
    case IdentityLineReadStatus.Found:
      return read.value;
    case IdentityLineReadStatus.FieldAbsent:
      return "";
    case IdentityLineReadStatus.ReadUnresolved:
      return "unknown (read-unresolved)";
  }
}

@Injectable()
export class IdentityDataService {
  readonly identityPath = identityPath;
  readonly openingPromptPath = openingPromptPath;
  readonly identityText = identityText;
  readonly composeOpeningPrompt = composeOpeningPrompt;
  readonly composeCodexOpeningPrompt = composeCodexOpeningPrompt;
  readonly containsSupervisionPollingLoop = containsSupervisionPollingLoop;
  readonly roleStandingInstruction = roleStandingInstruction;
  readonly roleNameFor = roleNameFor;
  readonly writeIdentity = (
    name: string,
    identity: AgentIdentity,
    baseDir?: string,
  ) => writeIdentity(name, identity, baseDir);
  readonly writeOpeningPrompt = (
    name: string,
    prompt: string,
    baseDir?: string,
  ) => writeOpeningPrompt(name, prompt, baseDir);
  readonly readOpeningPrompt = (name: string, baseDir?: string) =>
    readOpeningPrompt(name, baseDir);
  readonly readIdentityLine = (
    name: string,
    prefix: string,
    baseDir = DEFAULT_DATA_DIR,
  ) => readIdentityLine(name, prefix, baseDir);
  readonly readAgentRole = (name: string, baseDir?: string) =>
    readAgentRole(name, baseDir);
  readonly readAgentSupervisor = (name: string, baseDir?: string) =>
    readAgentSupervisor(name, baseDir);
  readonly readSpawnedTabLabel = (name: string, baseDir?: string) =>
    readSpawnedTabLabel(name, baseDir);
}
