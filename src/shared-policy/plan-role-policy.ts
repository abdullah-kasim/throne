import {
  modelPairInPool,
  type ModelPair,
  type ModelPairPool,
  type PlanPresetName,
  type PlanRole,
} from '../config.ts';

/** Where the durable `--bypass-model` authorization registry lives, named in the
 *  refusal itself: a reader who is told to pass the flag but not where its
 *  authorization is recorded still cannot act. Path is stated relative to the
 *  runtime data home so it survives a relocated `~/.throne`. */
const MODEL_BYPASS_REGISTRY_HINT =
  '<throne data home>/regent/bypass-model-authorizations.json';

/** Where the durable `--bypass-usage` authorization registry lives, named
 *  alongside the model registry above: a Shadow spawn that clears the
 *  pool/allowlist gate typically still needs this second, independent
 *  authorization from the execution-shadow usage steer, in its own file. */
const USAGE_BYPASS_REGISTRY_HINT =
  '<throne data home>/regent/bypass-usage-authorizations.json';

export function planRolePoolRefusal(opts: {
  preset: PlanPresetName;
  role: PlanRole;
  name: string;
  pair: ModelPair;
  pool: ModelPairPool;
  phase: 'requested' | 'resolved final';
  /** When the excluding source is an owner Alpha's own model-allowlist.json
   *  rather than the plain role pool, name it directly so the reader can go
   *  read the file instead of reverse-engineering the refusal. */
  poolSource?: { label: string; hint: string };
  ownerAllowlist?: boolean;
}): string | undefined {
  if (modelPairInPool(opts.pool, opts.pair)) return undefined;
  const allowed = opts.pool
    .map(({ harness, model }) => `${harness}/${model}`)
    .join(', ');
  const sourceLabel =
    opts.poolSource !== undefined
      ? `${opts.poolSource.label} (${opts.poolSource.hint})`
      : `active plan preset ${opts.preset}`;
  if (opts.ownerAllowlist) {
    return (
      `${sourceLabel} excludes the ${opts.phase} pair ` +
      `${opts.pair.harness}/${opts.pair.model} for ${opts.role} agent "${opts.name}"; ` +
      `that owner allowlist permits only: ${allowed || '(empty)'}. --bypass-model ` +
      `and every other bypass flag cannot override this owner allowlist. The Alpha ` +
      `must message the Regent to ask why this pair is excluded or ask permission ` +
      `to add it. Nothing was registered or launched.`
    );
  }
  return (
    `${sourceLabel} excludes the ${opts.phase} pair ` +
    `${opts.pair.harness}/${opts.pair.model} for ${opts.role} agent "${opts.name}"; ` +
    `that role's allowed pool is: ${allowed || '(empty)'}. The requested pair will ` +
    `not be silently substituted. To use this pair anyway, pass --bypass-model ` +
    `with a durable authorization for this exact objective code and recipient in ` +
    `${MODEL_BYPASS_REGISTRY_HINT}. Authorization comes from the Lord and is ` +
    `relayed by the Regent (a Regent recipient requires the Lord; an Alpha or ` +
    `Shadow recipient accepts the Lord or the Regent), and no agent may ` +
    `self-authorize. A Lord instruction naming a model for this campaign — for ` +
    `example "fable low end to end" — IS that authorization for its whole scope, ` +
    `so record it and proceed rather than asking again per spawn. A Shadow spawn ` +
    `that clears this gate typically still needs a SECOND, independent ` +
    `authorization — pass --bypass-usage with a durable authorization in ` +
    `${USAGE_BYPASS_REGISTRY_HINT}, a separate registry from the model one above. ` +
    `NEVER answer this refusal by silently accepting the pool default: that ` +
    `betrays an explicit model order without telling anyone`
  );
}
