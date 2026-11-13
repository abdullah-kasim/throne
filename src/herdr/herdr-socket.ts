import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  herdrFailureMeansServerChanged,
  isMutatingHerdrCommand,
  NestHerdrCommandError,
  OWNED_HERDR_CLIENT_RELEASE_TAG,
  ownedHerdrClientPath,
  THRONE_HERDR_PROTOCOL,
  type HerdrReadOnlyResult,
} from './herdr-client.ts';

type HerdrCallOptions = { env?: NodeJS.ProcessEnv; timeoutMilliseconds?: number };
type LaunchHerdr = (executablePath: string, args: readonly string[], options: HerdrCallOptions) => Promise<HerdrReadOnlyResult>;

interface SocketCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly printsReadText: boolean;
}

type SocketReply =
  | { readonly kind: 'answered'; readonly line: string; readonly reply: { result?: unknown; error?: { code?: string; message?: string } } }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'lost'; readonly detail: string };

const READ_FLAGS: Record<string, string> = { '--source': 'source', '--format': 'format', '--lines': 'lines' };

export function herdrSocketCall(commandArgs: readonly string[]): SocketCall | undefined {
  const [noun, verb, ...rest] = commandArgs;
  const command = `${noun} ${verb}`;
  const json = (method: string, params: Record<string, unknown> = {}) => ({ method, params, printsReadText: false });
  if (rest.length === 0 && command === 'agent list') return json('agent.list');
  if (rest.length === 0 && command === 'pane list') return json('pane.list');
  if (rest.length === 0 && command === 'tab list') return json('tab.list');
  if (command === 'pane process-info' && rest.length === 2 && rest[0] === '--pane') {
    return json('pane.process_info', { pane_id: rest[1] });
  }
  if (command === 'pane send-text' && rest.length === 2) {
    return json('pane.send_text', { pane_id: rest[0], text: rest[1] });
  }
  if (command === 'pane send-keys' && rest.length >= 2) {
    return json('pane.send_keys', { pane_id: rest[0], keys: rest.slice(1) });
  }
  if (command === 'agent read' && rest.length % 2 === 1) {
    const params: Record<string, unknown> = { target: rest[0], source: 'recent' };
    for (let index = 1; index < rest.length; index += 2) {
      const field = READ_FLAGS[rest[index]];
      if (field === undefined) return undefined;
      params[field] = field === 'lines' ? Number(rest[index + 1]) : rest[index + 1];
    }
    if (params.format === 'ansi') params.strip_ansi = false;
    return { method: 'agent.read', params, printsReadText: true };
  }
  return undefined;
}

export function herdrSocketPath(sessionName: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'herdr', 'sessions', sessionName, 'herdr.sock');
}

function askHerdrSocket(socketPath: string, method: string, params: object, timeoutMilliseconds?: number): Promise<SocketReply> {
  return new Promise((resolve) => {
    const connection = net.createConnection(socketPath);
    let requestSent = false;
    let received = '';
    const finish = (reply: SocketReply) => {
      connection.destroy();
      resolve(reply);
    };
    if (timeoutMilliseconds !== undefined) {
      connection.setTimeout(timeoutMilliseconds, () => finish({ kind: 'lost', detail: `no reply within ${timeoutMilliseconds}ms` }));
    }
    connection.on('connect', () => {
      requestSent = true;
      connection.write(`${JSON.stringify({ id: 'throne', method, params })}\n`);
    });
    connection.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const end = received.indexOf('\n');
      if (end < 0) return;
      const line = received.slice(0, end);
      try {
        finish({ kind: 'answered', line, reply: JSON.parse(line) });
      } catch {
        finish({ kind: 'lost', detail: `unreadable reply ${JSON.stringify(line.slice(0, 200))}` });
      }
    });
    connection.on('error', (failure) => finish(requestSent ? { kind: 'lost', detail: failure.message } : { kind: 'unreachable' }));
    connection.on('close', () => finish({ kind: 'lost', detail: 'herdr closed the socket without replying' }));
  });
}

const compatibleSockets = new Map<string, Promise<boolean>>();

function socketIsCompatible(socketPath: string): Promise<boolean> {
  let verdict = compatibleSockets.get(socketPath);
  if (verdict === undefined) {
    verdict = askHerdrSocket(socketPath, 'ping', {}, 5_000).then((pong) => {
      const result = pong.kind === 'answered' ? (pong.reply.result as { version?: unknown; protocol?: unknown } | undefined) : undefined;
      const compatible = result?.version === OWNED_HERDR_CLIENT_RELEASE_TAG.slice(1) && String(result.protocol) === THRONE_HERDR_PROTOCOL;
      if (!compatible) compatibleSockets.delete(socketPath);
      return compatible;
    });
    compatibleSockets.set(socketPath, verdict);
  }
  return verdict;
}

function socketCallFor(executablePath: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  if (args[0] !== '--session' || args[1] === undefined) return undefined;
  if (env.THRONE_HERDR_CLIENT_PATH?.trim() || executablePath !== ownedHerdrClientPath(env)) return undefined;
  const call = herdrSocketCall(args.slice(2));
  return call && { call, socketPath: herdrSocketPath(args[1], env) };
}

export async function executeHerdrOverSocketOrCommandLine(
  executablePath: string,
  args: readonly string[],
  options: HerdrCallOptions,
  launchHerdr: LaunchHerdr,
): Promise<HerdrReadOnlyResult> {
  const env = options.env ?? process.env;
  const routed = socketCallFor(executablePath, args, env);
  if (routed === undefined || !(await socketIsCompatible(routed.socketPath))) {
    return launchHerdr(executablePath, args, options);
  }
  const { call, socketPath } = routed;
  const answer = await askHerdrSocket(socketPath, call.method, call.params, options.timeoutMilliseconds);
  if (answer.kind === 'unreachable') {
    compatibleSockets.delete(socketPath);
    return launchHerdr(executablePath, args, options);
  }
  if (answer.kind === 'lost') {
    compatibleSockets.delete(socketPath);
    if (isMutatingHerdrCommand(args.slice(2))) {
      throw new NestHerdrCommandError(args, `outcome unknown, not resent: ${answer.detail}`, { code: 'socket_outcome_unknown' });
    }
    return launchHerdr(executablePath, args, options);
  }
  const { error, result } = answer.reply;
  if (error !== undefined) {
    const refusal = new NestHerdrCommandError(args, error.message ?? answer.line, { code: error.code, stdout: answer.line });
    if (!herdrFailureMeansServerChanged(refusal)) throw refusal;
    compatibleSockets.delete(socketPath);
    return launchHerdr(executablePath, args, options);
  }
  if (call.printsReadText) {
    return { stdout: String((result as { read?: { text?: unknown } } | undefined)?.read?.text ?? ''), stderr: '' };
  }
  return { stdout: `${JSON.stringify({ id: `cli:${call.method.replace('.', ':')}`, result })}\n`, stderr: '' };
}
