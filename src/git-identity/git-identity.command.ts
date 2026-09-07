import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import { loadUserConfigFile } from '../user-config-loader.ts';

const execFileAsync = promisify(execFile);

export type GitSigningFormat = 'openpgp' | 'ssh';

/** Signing is mandatory (Lord, 2026-09-08): an identity without a key is no
 *  identity at all, and the shim STOPs on it exactly as on a missing one. */
export interface GitIdentity {
  name: string;
  email: string;
  signingKey: string;
  signingFormat: GitSigningFormat;
}

/**
 * The `identity` section of config.user.ts:
 *
 *   identity: {
 *     name: 'Full Name', email: 'me@example.com',          // the default
 *     signingKey: 'EF48…113B',                             // gpg key id, or an ssh public key path with signingFormat: 'ssh'
 *     identities: { work: { name: 'Full Name', email: 'me@examplecorp.example', signingKey: '…' } },
 *     remotes: {                                            // pattern -> identity name
 *       'github.com:ExampleCorp': 'work',                     // host:owner
 *       'github.example-corp.com': 'work',                            // whole host
 *       'github.com:example-owner': 'default',             // 'default' = name/email above
 *     },
 *   }
 *
 * A remote pattern is matched against the repository's `origin` URL in either
 * ssh or https form, case-insensitively; `host:owner` beats `host`. No match,
 * or no origin, falls back to the default identity.
 */
export interface GitIdentitySection {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly signingKey?: unknown;
  readonly signingFormat?: unknown;
  readonly identities?: unknown;
  readonly remotes?: unknown;
}

export interface GitIdentityDependencies {
  readIdentitySection(): Promise<Readonly<Record<string, unknown>> | undefined>;
  readOriginUrl(repo: string): Promise<string | undefined>;
  cwd(): string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const GIT_IDENTITY_UNSET_EXIT_CODE = 3;

export const USAGE =
  'Usage: ./bin/throne-cli git-identity [--repo <path>] [--remote <origin url>]\n' +
  'Prints the git author identity for a repository as `<name>\\t<email>\\t<signing key>\\t<openpgp|ssh>`, from the live throne config.user.ts `identity` section:\n' +
  'the `remotes` rule matching the repository origin (`host:owner` before `host`), else the default `name`/`email`.\n' +
  '--repo defaults to the cwd; --remote supplies the origin URL directly instead of reading it from the repository.\n' +
  'Exit 3 when nothing applies (the git shim then refuses a machine-local identity), 1 when the file cannot be loaded.\n';

function signingFrom(
  value: { signingKey?: unknown; signingFormat?: unknown },
  inherited?: { signingKey?: unknown; signingFormat?: unknown },
): { signingKey: string; signingFormat: GitSigningFormat } | undefined {
  const key = typeof value.signingKey === 'string' && value.signingKey.trim() !== ''
    ? value.signingKey.trim()
    : typeof inherited?.signingKey === 'string' && inherited.signingKey.trim() !== ''
      ? inherited.signingKey.trim()
      : undefined;
  if (key === undefined) return undefined;
  const format = value.signingFormat ?? inherited?.signingFormat ?? 'openpgp';
  if (format !== 'openpgp' && format !== 'ssh') return undefined;
  return { signingKey: key, signingFormat: format };
}

/** A usable identity needs name, email AND a signing key; a named identity
 *  may inherit the top-level key when it names none of its own. */
function identityFrom(
  value: unknown,
  inherited?: { signingKey?: unknown; signingFormat?: unknown },
): GitIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { name?: unknown; email?: unknown; signingKey?: unknown; signingFormat?: unknown };
  const { name, email } = record;
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  if (typeof email !== 'string' || email.trim() === '') return undefined;
  const signing = signingFrom(record, inherited);
  if (signing === undefined) return undefined;
  return { name: name.trim(), email: email.trim(), ...signing };
}

/** Name and email present but no signing key anywhere — the STOP's reason
 *  must say "signing key", not "identity". */
export function identityLacksOnlySigningKey(section: Readonly<Record<string, unknown>> | undefined): boolean {
  if (typeof section !== 'object' || section === null) return false;
  const { name, email } = section as { name?: unknown; email?: unknown };
  return typeof name === 'string' && name.trim() !== '' && typeof email === 'string' && email.trim() !== '' && resolveGitIdentity(section) === undefined;
}

/** The default identity alone — what an empty worktree or a repo without a
 *  matching remote rule signs with. */
export function resolveGitIdentity(
  section: Readonly<Record<string, unknown>> | undefined,
): GitIdentity | undefined {
  return identityFrom(section);
}

/** `git@github.com:ExampleCorp/some-repo.git`, `ssh://git@github.example-corp.com/org/repo`,
 *  `https://github.com/example-owner/x` -> `{ host, owner }` (lower-cased). */
export function parseRemote(url: string): { host: string; owner: string } | undefined {
  const trimmed = url.trim();
  let host: string | undefined;
  let pathPart: string | undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  const full = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (full) {
    host = full[1];
    pathPart = full[2];
  } else if (scp && !trimmed.includes('://')) {
    host = scp[1];
    pathPart = scp[2];
  }
  if (host === undefined || pathPart === undefined) return undefined;
  const owner = pathPart.replace(/^\/+/, '').split('/')[0] ?? '';
  return { host: host.toLowerCase(), owner: owner.toLowerCase() };
}

/** Resolves the identity for one remote URL. `remotes` keys are `host` or
 *  `host:owner`; the value names an entry of `identities`, or `default`. */
export function resolveGitIdentityForRemote(
  section: Readonly<Record<string, unknown>> | undefined,
  remoteUrl: string | undefined,
): GitIdentity | undefined {
  const fallback = resolveGitIdentity(section);
  const rules = section?.['remotes'];
  const named = section?.['identities'];
  if (remoteUrl === undefined || typeof rules !== 'object' || rules === null) return fallback;
  const parsed = parseRemote(remoteUrl);
  if (parsed === undefined) return fallback;
  let best: { specificity: number; alias: unknown } | undefined;
  for (const [pattern, alias] of Object.entries(rules as Record<string, unknown>)) {
    const [patternHost, patternOwner] = pattern.toLowerCase().split(':');
    if (patternHost !== parsed.host) continue;
    if (patternOwner !== undefined && patternOwner !== '' && patternOwner !== parsed.owner) continue;
    const specificity = patternOwner ? 2 : 1;
    if (best === undefined || specificity > best.specificity) best = { specificity, alias };
  }
  if (best === undefined) return fallback;
  if (best.alias === 'default') return fallback;
  if (typeof best.alias === 'string' && typeof named === 'object' && named !== null) {
    return identityFrom((named as Record<string, unknown>)[best.alias], section) ?? fallback;
  }
  return identityFrom(best.alias, section) ?? fallback;
}

let cacheBustSequence = 0;

export async function readOriginUrl(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const url = stdout.trim();
    return url === '' ? undefined : url;
  } catch {
    return undefined;
  }
}

const PRODUCTION_DEPENDENCIES: GitIdentityDependencies = {
  async readIdentitySection() {
    // Read fresh every call: the shim invokes this per commit and the Lord
    // edits config.user.ts while the court runs.
    const file = await loadUserConfigFile(undefined, `${Date.now()}-${++cacheBustSequence}`);
    return file?.identity;
  },
  readOriginUrl,
  cwd: () => process.cwd(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface ParsedArgs {
  repo?: string;
  remote?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--repo' || arg === '--remote') {
      const value = args[index + 1];
      if (value === undefined || value === '') throw new Error(`${arg} requires a value`);
      if (arg === '--repo') parsed.repo = value;
      else parsed.remote = value;
      index += 1;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return parsed;
}

export async function runGitIdentity(
  args: string[],
  dependencies: GitIdentityDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: `git-identity entrance validation refused: ${error instanceof Error ? error.message : String(error)}.`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  let section: Readonly<Record<string, unknown>> | undefined;
  try {
    section = await dependencies.readIdentitySection();
  } catch (error) {
    dependencies.writeStderr(
      `git-identity: config.user.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const remote = parsed.remote ?? (await dependencies.readOriginUrl(parsed.repo ?? dependencies.cwd()));
  const identity = resolveGitIdentityForRemote(section, remote);
  if (identity === undefined) {
    dependencies.writeStderr(
      identityLacksOnlySigningKey(section)
        ? 'git-identity: signing key is mandatory — `identity.signingKey` (a gpg key id, or an ssh key path with `signingFormat: \'ssh\'`) is absent or blank in the live throne config.user.ts.\n'
        : 'git-identity: no identity applies — `identity.name`/`identity.email`/`identity.signingKey` are absent or blank in the live throne config.user.ts' +
            (remote === undefined ? ' (and the repository has no origin to match a `remotes` rule).\n' : ` and no \`remotes\` rule matches ${remote}.\n`),
    );
    return GIT_IDENTITY_UNSET_EXIT_CODE;
  }
  dependencies.writeStdout(`${identity.name}\t${identity.email}\t${identity.signingKey}\t${identity.signingFormat}\n`);
  return 0;
}

@Command({
  name: 'git-identity',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class GitIdentityCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runGitIdentity(passedParams);
  }
}
