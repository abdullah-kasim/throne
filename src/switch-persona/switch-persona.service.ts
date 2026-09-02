// `switch-persona` — the write half of the RPL preset layer
// (`application-config.service.ts`). RPL landed `ROLEPLAY_PRESETS` and the
// gitignored `config.user.ts` override that selects one via `roleplayPreset`,
// but the only way to flip it was a hand-edit of that TypeScript file — the
// exact hand-edit pain `switch-agent-model` exists to eliminate on the
// model/route surface. This module is the narrow text-edit mechanism: it
// touches only the `roleplayPreset` field of `config.user.ts`, preserving
// every other override (including comments) byte-for-byte, and never invents
// a second validation vocabulary — every read and every post-write check goes
// through `loadValidatedPersonaOverride`, the same import+validate path
// `loadPersonaConfig` uses.
//
// Three Lord's rulings extend the base switch (2026-08-08, see
// `agent_docs/ROLEPLAY_POLICY.md` and the campaign brief):
//   1. The live court must be reached too — `switch-persona-broadcast.ts`
//      messages every live registered agent (never clearing a blocked
//      marker; see that file's header).
//   2. Ledger agent-name grammar (`alpha-*`/`shadow-*`) and every other
//      on-disk identifier stay fixed — the broadcast is a message, never a
//      rename. (Tab-label/agent-name rename itself is tracked separately;
//      see `REPORT.md` for what shipped in this pass and why.)
//   3. The persona a switch moves AWAY from is recorded durably via
//      `switch-persona-history.ts` before the new one is written.

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  loadValidatedPersonaOverride,
  mergePersonaConfig,
  personaUserConfigPath,
  ROLEPLAY_PRESET_NAMES,
  ROLEPLAY_PRESETS,
  type PersonaConfig,
  type RoleplayPresetName,
} from "../application-config.service.ts";
import { resolveLiveThroneRoot } from "../throne-root-resolution.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { listRegisteredAgentNames } from "../agent-statuses/agent-statuses-registry.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { submitToAgentViaQueue } from "../throne-work/enqueue-heartbeat-message.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import {
  syncPersonaLedgerSymlinks,
  type PersonaLedgerSymlinkSyncResult,
} from "../agentdata/ledger-data.service.ts";
import {
  broadcastPersonaSwitch,
  type PersonaBroadcastDeps,
  type PersonaBroadcastResult,
} from "./switch-persona-broadcast.ts";
import {
  personaHistoryPath,
  readPersonaHistory,
  writePersonaHistory,
} from "./switch-persona-history.ts";

export interface SwitchPersonaDeps {
  readonly configPath?: string;
  readonly historyPath?: string;
  readonly readFileIfExists: (path: string) => Promise<string | undefined>;
  readonly writeFileText: (path: string, text: string) => Promise<void>;
  readonly now: () => Date;
  readonly broadcast: (
    presetName: RoleplayPresetName,
    config: PersonaConfig,
  ) => Promise<PersonaBroadcastResult>;
  readonly syncSymlinks: (
    config: PersonaConfig,
  ) => Promise<PersonaLedgerSymlinkSyncResult>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Production `readFileIfExists`: absent-file is a normal outcome here, not
 *  an error — mirrors `loadValidatedPersonaOverride`'s absent-file contract. */
export async function readFileIfExistsReal(
  path: string,
): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function productionBroadcastDeps(): Promise<
  PersonaBroadcastDeps<HerdrAgent>
> {
  let senderName: string;
  try {
    senderName = await resolveCurrentAgentName();
  } catch {
    // Not every invocation runs inside a herdr agent pane (e.g. the Lord
    // running it directly) — a synthetic, clearly-labelled sender is still
    // enough provenance for a vocabulary-only administrative message.
    senderName = "switch-persona";
  }
  return {
    senderName,
    listRegisteredAgentNames: () => listRegisteredAgentNames(),
    resolveAgent: (name) => resolveAgent(name),
    // Persona broadcasts route through the durable queue too — a live agent
    // mid-turn no longer makes this broadcast throw for that one agent; the
    // server retries instead. See `enqueue-heartbeat-message.ts`.
    submitToAgent: (agent, sender, prompt) =>
      submitToAgentViaQueue(agent, sender, prompt),
    excludeNames: [senderName],
  };
}

export function productionSwitchPersonaDeps(): SwitchPersonaDeps {
  return {
    readFileIfExists: readFileIfExistsReal,
    writeFileText: (path, text) => writeFile(path, text, "utf8"),
    now: () => new Date(),
    broadcast: async (presetName, config) =>
      broadcastPersonaSwitch(
        presetName,
        config,
        await productionBroadcastDeps(),
      ),
    syncSymlinks: (config) =>
      syncPersonaLedgerSymlinks(RUNTIME_DATA_DIR, config),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}

const MINIMAL_FILE_TEMPLATE = (presetName: RoleplayPresetName): string =>
  `// LOCAL display/persona override — gitignored, this machine only.\n` +
  `// Created by \`switch-persona\`. See \`config.user.example.ts\` for the\n` +
  `// full field contract and \`agent_docs/ROLEPLAY_POLICY.md\` for the policy.\n\n` +
  `import type { PersonaConfigOverride } from './src/application-config.service.ts';\n\n` +
  `const personaOverride: PersonaConfigOverride = {\n` +
  `  roleplayPreset: '${presetName}',\n` +
  `};\n\n` +
  `export default personaOverride;\n`;

// Matches an existing `roleplayPreset: '...'` (or `"..."`) key/value pair —
// narrow on purpose: this is the ONLY thing this module ever rewrites.
const EXISTING_KEY_RE = /roleplayPreset\s*:\s*(['"])(?:(?!\1).)*\1/;
// Matches the opening brace of the default-exported object literal, in
// either shape the template/live file use: `export default {` or
// `<name>: PersonaConfigOverride = {`.
const OBJECT_OPEN_RE =
  /(export\s+default\s*|const\s+\w+\s*(?::[^=\n]+)?=\s*)\{/;

/**
 * Pure text transform: given the current `config.user.ts` source (or
 * `undefined` when the file does not exist yet), returns the new source with
 * `roleplayPreset` set to `presetName` and everything else byte-identical.
 * Throws if an EXISTING file's default-exported object literal cannot be
 * located — this function is only ever called after the caller has already
 * confirmed the file imports and validates cleanly, so that would mean the
 * narrow regex missed a real shape, not that the file itself is invalid.
 */
export function applyPresetToConfigSource(
  currentSource: string | undefined,
  presetName: RoleplayPresetName,
): string {
  if (currentSource === undefined) return MINIMAL_FILE_TEMPLATE(presetName);

  if (EXISTING_KEY_RE.test(currentSource)) {
    return currentSource.replace(
      EXISTING_KEY_RE,
      `roleplayPreset: '${presetName}'`,
    );
  }

  const openMatch = OBJECT_OPEN_RE.exec(currentSource);
  if (!openMatch) {
    throw new Error(
      "switch-persona could not locate the default-exported object literal " +
        "in the existing config.user.ts to insert `roleplayPreset` — the " +
        "file validated but its shape is not one this narrow editor " +
        "recognizes. Add `roleplayPreset: '...'` to it by hand instead.",
    );
  }
  const insertAt = openMatch.index + openMatch[0].length;
  return (
    currentSource.slice(0, insertAt) +
    `\n  roleplayPreset: '${presetName}',` +
    currentSource.slice(insertAt)
  );
}

function presetList(): string {
  return ROLEPLAY_PRESET_NAMES.join(", ");
}

function isKnownPreset(name: string): name is RoleplayPresetName {
  return (ROLEPLAY_PRESET_NAMES as readonly string[]).includes(name);
}

const SPAWN_TIME_NOTE =
  "Persona is seeded into an opening prompt at spawn time. Newly spawned " +
  "agents pick up the switch automatically; live agents were just sent a " +
  "vocabulary-update message (see below) since config alone cannot reach " +
  "a process already running.";

async function resolveConfigPath(deps: SwitchPersonaDeps): Promise<string> {
  if (deps.configPath) return deps.configPath;
  return personaUserConfigPath(await resolveLiveThroneRoot());
}

function resolveHistoryPath(deps: SwitchPersonaDeps): string {
  return deps.historyPath ?? personaHistoryPath(RUNTIME_DATA_DIR);
}

async function showCurrent(
  configPath: string,
  deps: SwitchPersonaDeps,
): Promise<number> {
  let override;
  try {
    override = await loadValidatedPersonaOverride(configPath);
  } catch (cause) {
    deps.err(`${(cause as Error).message}\n`);
    return 1;
  }
  const active = override?.roleplayPreset ?? "Default";
  const source =
    override === undefined
      ? `no config.user.ts present at "${configPath}"`
      : override.roleplayPreset === undefined
        ? `config.user.ts present but sets no roleplayPreset`
        : `config.user.ts`;
  deps.out(`Active roleplay preset: ${active} (${source})\n`);
  deps.out(`Available presets: ${presetList()}\n`);

  const history = await readPersonaHistory(resolveHistoryPath(deps)).catch(
    (cause) => {
      deps.err(`(persona history unreadable: ${(cause as Error).message})\n`);
      return undefined;
    },
  );
  if (history) {
    deps.out(
      `Previous preset: ${history.previousPreset} (switched to ` +
        `${history.switchedToPreset} at ${history.switchedAt})\n`,
    );
  } else {
    deps.out("Previous preset: none recorded yet.\n");
  }
  deps.out(
    "Persona is seeded at agent spawn time; switching does not itself alter a " +
      "live agent, but `switch-persona <preset>` also broadcasts a vocabulary " +
      "update to every currently live agent.\n",
  );
  return 0;
}

async function listPresets(deps: SwitchPersonaDeps): Promise<number> {
  deps.out(`Available presets: ${presetList()}\n`);
  return 0;
}

function reportBroadcast(
  result: PersonaBroadcastResult,
  deps: SwitchPersonaDeps,
): void {
  if (result.updated.length === 0 && result.unreachable.length === 0) {
    deps.out("Live court: no other registered agents to update.\n");
    return;
  }
  deps.out(
    `Live court updated (${result.updated.length}): ` +
      `${result.updated.length ? result.updated.join(", ") : "(none)"}\n`,
  );
  if (result.unreachable.length > 0) {
    deps.err(
      `Live court UNREACHABLE (${result.unreachable.length}) — these agents ` +
        "were NOT updated and are still speaking the previous persona:\n",
    );
    for (const { name, reason } of result.unreachable) {
      deps.err(`  - ${name}: ${reason}\n`);
    }
  }
}

async function switchTo(
  presetName: string,
  configPath: string,
  deps: SwitchPersonaDeps,
): Promise<number> {
  if (!isKnownPreset(presetName)) {
    deps.err(
      `${renderEntranceRefusal({
        reason: `Unknown roleplay preset "${presetName}". Valid presets: ${presetList()}.`,
        bypass: undefined,
        supervisorRoute:
          "Ask your supervisor for an allowed persona or alternative invocation.",
      })}\n`,
    );
    return 1;
  }

  // Refuse to touch a file that is already present but invalid — reuse the
  // one validator's error vocabulary rather than silently repairing or
  // overwriting it.
  let currentSource: string | undefined;
  let currentOverride;
  try {
    currentOverride = await loadValidatedPersonaOverride(configPath);
    currentSource = await deps.readFileIfExists(configPath);
  } catch (cause) {
    deps.err(`${(cause as Error).message}\n`);
    deps.err(
      "Fix the file by hand, then retry — switch-persona will not overwrite an invalid override.\n",
    );
    return 1;
  }
  const previousPreset: RoleplayPresetName =
    currentOverride?.roleplayPreset ?? "Default";

  const newSource = applyPresetToConfigSource(currentSource, presetName);
  await deps.writeFileText(configPath, newSource);

  // Verify the write round-trips to the intended preset before declaring
  // success — a mismatch here means the narrow text edit landed somewhere
  // that doesn't parse as the field we meant to set. Pass a cache-bust token:
  // this is a second import() of the SAME path within one process, and
  // Node's ESM loader would otherwise silently serve the pre-write module.
  const written = await loadValidatedPersonaOverride(
    configPath,
    `post-write-${randomUUID()}`,
  );
  if (written?.roleplayPreset !== presetName) {
    deps.err(
      `switch-persona wrote "${configPath}" but the written file's ` +
        `roleplayPreset resolved to ${describeResolved(written)}, not ` +
        `"${presetName}" — the edit did not verify. Inspect the file by hand.\n`,
    );
    return 1;
  }

  // Record what we're moving AWAY from before reporting success — a crash
  // between the config write above and this record would leave the history
  // stale (still naming the true previous state), never corrupt, since the
  // record only ever describes states that were each fully written.
  await writePersonaHistory(resolveHistoryPath(deps), {
    previousPreset,
    switchedToPreset: presetName,
    switchedAt: deps.now().toISOString(),
  });

  deps.out(
    `Switched active roleplay preset to ${presetName} ("${configPath}").\n`,
  );
  deps.out(`Previous preset: ${previousPreset} (recorded).\n`);
  deps.out(`${SPAWN_TIME_NOTE}\n`);

  const newConfig = mergePersonaConfig(ROLEPLAY_PRESETS[presetName], written);

  const symlinkSyncResult = await deps.syncSymlinks(newConfig);
  reportSymlinkSync(symlinkSyncResult, deps);

  const broadcastResult = await deps.broadcast(presetName, newConfig);
  reportBroadcast(broadcastResult, deps);

  return 0;
}

function reportSymlinkSync(
  result: PersonaLedgerSymlinkSyncResult,
  deps: SwitchPersonaDeps,
): void {
  if (result.created.length === 0 && result.removed.length === 0) {
    deps.out("Ledger addressing symlinks: nothing to change.\n");
    return;
  }
  deps.out(
    `Ledger addressing symlinks — created (${result.created.length}): ` +
      `${result.created.length ? result.created.join(", ") : "(none)"}, ` +
      `removed (${result.removed.length}): ` +
      `${result.removed.length ? result.removed.join(", ") : "(none)"}.\n`,
  );
}

function describeResolved(
  override: { roleplayPreset?: RoleplayPresetName } | undefined,
): string {
  if (override === undefined) return "undefined (file read back as absent)";
  return override.roleplayPreset ?? "Default (unset)";
}

/** Entry point: `passedParams[0]` is the preset name to switch to, `--list`
 *  lists presets, and no argument shows the currently active preset. */
export async function runSwitchPersona(
  passedParams: readonly string[],
  deps: SwitchPersonaDeps,
): Promise<number> {
  const configPath = await resolveConfigPath(deps);
  const [first] = passedParams;

  if (first === undefined || first === "--show" || first === "show") {
    return showCurrent(configPath, deps);
  }
  if (first === "--list" || first === "list") {
    return listPresets(deps);
  }
  return switchTo(first, configPath, deps);
}
