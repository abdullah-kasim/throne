import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";

export interface CommandAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandAnswerer = (args: readonly string[], callerDirectory: string) => Promise<CommandAnswer>;

export interface CommandsOnPath {
  readonly binDirectory: string;
  remove(): Promise<void>;
}

const COMMAND_NAME_HEADER = "command-name";
const CALLER_DIRECTORY_HEADER = "caller-directory";
const OUTPUT_DIRECTORY_HEADER = "output-directory";
const STANDARD_OUTPUT_FILE = "stdout";
const STANDARD_ERROR_FILE = "stderr";
const ARGUMENT_SEPARATOR = "\0";

function scriptForwardingTo(port: number, name: string): string {
  return [
    "#!/bin/sh",
    'output="$(mktemp -d)"',
    `exitCode="$(printf '%s\\0' "$@" | curl --silent --data-binary @- --header "${COMMAND_NAME_HEADER}: ${name}" --header "${CALLER_DIRECTORY_HEADER}: $PWD" --header "${OUTPUT_DIRECTORY_HEADER}: $output" http://127.0.0.1:${port}/)"`,
    `cat "$output/${STANDARD_OUTPUT_FILE}"`,
    `cat "$output/${STANDARD_ERROR_FILE}" >&2`,
    'rm -r "$output"',
    'exit "$exitCode"',
    "",
  ].join("\n");
}

export async function startCommandAnsweringServer(answerers: Readonly<Record<string, CommandAnswerer>>): Promise<Server> {
  const server = createServer(async (request, response) => {
    const args = (await buffer(request)).toString("utf8").split(ARGUMENT_SEPARATOR).slice(0, -1);
    const outputDirectory = request.headers[OUTPUT_DIRECTORY_HEADER] as string;
    const answer = answerers[request.headers[COMMAND_NAME_HEADER] as string]!;
    const result = await answer(args, request.headers[CALLER_DIRECTORY_HEADER] as string);
    await writeFile(path.join(outputDirectory, STANDARD_OUTPUT_FILE), result.stdout);
    await writeFile(path.join(outputDirectory, STANDARD_ERROR_FILE), result.stderr);
    response.end(String(result.exitCode));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

export async function installCommandsForwardingTo(port: number, names: readonly string[]): Promise<CommandsOnPath> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "commands-in-this-process-"));
  for (const name of names) {
    const commandPath = path.join(binDirectory, name);
    await writeFile(commandPath, scriptForwardingTo(port, name));
    await chmod(commandPath, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ""}`;
  return {
    binDirectory,
    async remove() {
      process.env.PATH = previousPath;
      await rm(binDirectory, { recursive: true, force: true });
    },
  };
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function installCommandsAnsweredInThisProcess(answerers: Readonly<Record<string, CommandAnswerer>>): Promise<CommandsOnPath> {
  const server = await startCommandAnsweringServer(answerers);
  const commands = await installCommandsForwardingTo((server.address() as AddressInfo).port, Object.keys(answerers));
  return {
    binDirectory: commands.binDirectory,
    async remove() {
      await commands.remove();
      await closeServer(server);
    },
  };
}
