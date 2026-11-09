import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { withExclusiveFileLock } from "../shared-policy/exclusive-file-lock.ts";
import { loadUserConfigFile, writeConfigModulePackageIfMissing } from "../user-config-loader.ts";
import { TailnetPublishingHostedWorker } from "../web-listener/tailnet-publishing.hosted-worker.ts";
import { startWebListener } from "../web-listener/web-listener-app.ts";
import { previewsFromConfig } from "./preview-entries.ts";
import { runPreview, type PreviewDependencies } from "./preview-runtime.ts";

const HOST = "invented-host.example.ts.net";
const EXAMPLE_CONFIG = path.join(import.meta.dirname, "..", "..", "config.user.example.ts");
const LONG_ENOUGH_FOR_AN_APPLY_TO_START_MS = 150;
const STATUS_READ_CALLS = ["serve status --json", "status --self --json"];
const FAKE_TAILSCALE = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/calls"
if [ "$1 $2" = "serve status" ]; then
  cat "$(dirname "$0")/status.json"
fi
if [ "$1 $2" = "status --self" ]; then
  printf '{"Self":{"DNSName":"${HOST}."}}'
fi
`;

let scratch: string;
let room: string;
let listener: NestExpressApplication;
let listenerPort: number;
let logged: string[];
let printed: string[];
let complaints: string[];

function configPath(): string {
  return path.join(scratch, "config.user.ts");
}

function ledgerPath(): string {
  return path.join(room, "state", "tailnet-routes.json");
}

function dependencies(): PreviewDependencies {
  return {
    tailscaleCommand: path.join(room, "tailscale"),
    ledgerPath: ledgerPath(),
    listenerPort,
    configPath: configPath(),
    log: (message) => logged.push(message),
    out: (line) => printed.push(line),
    err: (line) => complaints.push(line),
  };
}

function applyTheList(): Promise<void> {
  return new TailnetPublishingHostedWorker(dependencies()).runOnce();
}

async function configLists(previews: readonly unknown[]): Promise<void> {
  await writeFile(configPath(), `export default { previews: ${JSON.stringify(previews)} };\n`);
}

async function tailnetShows(status: unknown): Promise<void> {
  await writeFile(path.join(room, "status.json"), JSON.stringify(status));
}

function tailnetHolding(handlers: Record<string, { Proxy: string }>, httpsPort = 443): unknown {
  return { Web: { [`${HOST}:${httpsPort}`]: { Handlers: handlers } } };
}

async function tailscaleCalls(): Promise<string[]> {
  const calls = await readFile(path.join(room, "calls"), "utf8").catch(() => "");
  return calls.split("\n").filter((call) => call !== "");
}

async function changingCalls(): Promise<string[]> {
  const calls = await tailscaleCalls();
  return calls.filter((call) => !STATUS_READ_CALLS.includes(call) && !call.includes(`--set-path /throne `) && !call.includes(`--set-path /where-i-stand `));
}

function folderRoute(name: string): string {
  return `http://127.0.0.1:${listenerPort}/previews/${name}`;
}

async function folderHolding(name: string, files: Record<string, string>): Promise<string> {
  const folder = path.join(scratch, name);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), text);
  }
  return folder;
}

function get(url: string): Promise<Response> {
  return fetch(url, { redirect: "manual" });
}

before(async () => {
  room = await mkdtemp(path.join(os.tmpdir(), "previews-room-"));
  scratch = path.join(room, "config");
  await writeFile(path.join(room, "tailscale"), FAKE_TAILSCALE);
  await chmod(path.join(room, "tailscale"), 0o755);
  listener = await startWebListener({ port: 0, webRoot: path.join(room, "web"), configPath: configPath() });
  listenerPort = (listener.getHttpServer().address() as AddressInfo).port;
});

after(async () => {
  await listener.close();
  await rm(room, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch);
  await writeConfigModulePackageIfMissing(scratch);
  await rm(path.join(room, "state"), { recursive: true, force: true });
  await rm(path.join(room, "calls"), { force: true });
  await tailnetShows({});
  logged = [];
  printed = [];
  complaints = [];
});

test("a preview entry with a path and an address is published on the tailnet", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173" }]);

  await applyTheList();

  assert.deepEqual(await changingCalls(), ["serve --bg --https=443 --set-path /mock http://127.0.0.1:4173"]);
  assert.deepEqual(logged, []);
});

test("a preview entry with a port and an address is published on the tailnet", async () => {
  await configLists([{ port: 8446, address: "http://127.0.0.1:5173" }]);

  await applyTheList();

  assert.deepEqual(await changingCalls(), ["serve --bg --https=8446 --set-path / http://127.0.0.1:5173"]);
});

test("a preview entry with a folder is served by the listener and published on the tailnet", async () => {
  const folder = await folderHolding("shots", { "index.html": "the shots", "one/two.txt": "deep file" });
  const site = await folderHolding("site", { "index.html": "the site" });
  await configLists([{ path: "/shots", folder }, { port: 8447, folder: site }]);

  await applyTheList();

  assert.deepEqual(await changingCalls(), [
    `serve --bg --https=443 --set-path /shots ${folderRoute("443-shots")}`,
    `serve --bg --https=8447 --set-path / ${folderRoute("8447")}`,
  ]);
  assert.equal(await (await get(`${folderRoute("443-shots")}/`)).text(), "the shots");
  assert.equal(await (await get(`${folderRoute("443-shots")}/one/two.txt`)).text(), "deep file");
  assert.equal(await (await get(`${folderRoute("8447")}/`)).text(), "the site");
});

test("a folder preview added while the listener runs is served without a restart", async () => {
  await configLists([]);
  assert.equal((await get(`${folderRoute("443-late")}/`)).status, 404);

  await configLists([{ path: "/late", folder: await folderHolding("late", { "index.html": "added late" }) }]);

  assert.equal(await (await get(`${folderRoute("443-late")}/`)).text(), "added late");
});

test("a folder opened without its closing slash redirects where the tailnet path still works", async () => {
  const folder = await folderHolding("shots", { "index.html": "the shots", "inner/index.html": "inner page" });
  await configLists([{ path: "/shots", folder }]);

  const atTheMount = await get(`${folderRoute("443-shots")}?size=2`);
  const inside = await get(`${folderRoute("443-shots")}/inner`);

  assert.equal(atTheMount.status, 302);
  assert.equal(atTheMount.headers.get("location"), "shots/?size=2");
  assert.equal(inside.headers.get("location"), "inner/");
  assert.equal(await (await get(`${folderRoute("443-shots")}/inner/`)).text(), "inner page");
});

test("a folder preview answers a missing file and a climb out of the folder with a plain 404", async () => {
  await folderHolding("secret", { "outside.txt": "must stay private" });
  await configLists([{ path: "/shots", folder: await folderHolding("shots", { "index.html": "the shots" }) }]);

  for (const urlPath of ["/gone.txt", "/..%2fsecret%2foutside.txt"]) {
    const response = await get(`${folderRoute("443-shots")}${urlPath}`);
    assert.equal(response.status, 404, urlPath);
    assert.doesNotMatch(await response.text(), /must stay private/);
  }
});

test("a preview removed from the config is taken off the tailnet", async () => {
  await configLists([
    { path: "/mock", address: "http://127.0.0.1:4173" },
    { port: 8446, address: "http://127.0.0.1:5173" },
  ]);
  await applyTheList();
  await tailnetShows({
    Web: {
      [`${HOST}:443`]: { Handlers: { "/mock": { Proxy: "http://127.0.0.1:4173" } } },
      [`${HOST}:8446`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
    },
  });
  await rm(path.join(room, "calls"));
  await configLists([]);

  await applyTheList();

  assert.deepEqual(await changingCalls(), ["serve --https=443 --set-path /mock off", "serve --https=8446 --set-path / off"]);
  const ledger = JSON.parse(await readFile(ledgerPath(), "utf8")) as { places: { path: string }[] };
  assert.deepEqual(ledger.places.map((place) => place.path), ["/throne", "/where-i-stand"]);
});

test("a preview entry that names both a path and a port is refused naming the field", async () => {
  await configLists([{ path: "/mock", port: 8446, address: "http://127.0.0.1:4173" }]);

  await assert.rejects(previewsFromConfig(configPath()), /0\.path: give exactly one of path or port/);
});

test("a preview entry that names both an address and a folder is refused naming the field", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173", folder: "/srv/site" }]);

  await assert.rejects(previewsFromConfig(configPath()), /0\.address: give exactly one of address or folder/);
});

test("a preview entry with neither a place nor a source is refused naming the field", async () => {
  await configLists([{}]);

  await assert.rejects(previewsFromConfig(configPath()), /0\.path: give exactly one.*0\.address: give exactly one/);
});

test("an invalid list publishes nothing and takes nothing down", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173" }]);
  await applyTheList();
  await tailnetShows(tailnetHolding({ "/mock": { Proxy: "http://127.0.0.1:4173" } }));
  await rm(path.join(room, "calls"));
  await configLists([{ path: "/mock" }]);

  await applyTheList();

  assert.deepEqual(await changingCalls(), []);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /nothing published this run: .*0\.address: give exactly one/);
});

test("an unknown key in a preview entry is refused naming the field", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173", adress: "typo" }]);

  await assert.rejects(previewsFromConfig(configPath()), /adress/);
});

test("an address that is not on this machine is refused", async () => {
  for (const address of ["http://192.0.2.7:4173", "http://example.com", "not an address"]) {
    await configLists([{ path: "/mock", address }]);

    await assert.rejects(previewsFromConfig(configPath()), /0\.address: must be an address on this machine/, address);
  }
});

test("every spelling of an address on this machine is accepted", async () => {
  const addresses = ["http://127.0.0.1:4173", "http://localhost:4173", "http://[::1]:4173"];
  await configLists(addresses.map((address, index) => ({ port: 9000 + index, address })));

  assert.equal((await previewsFromConfig(configPath())).length, addresses.length);
});

test("an address tailscale cannot serve is refused and never reaches the list", async () => {
  for (const address of ["http://127.0.0.1", "http://localhost/app", "ftp://127.0.0.1:4173"]) {
    const exitCode = await runPreview(["add", "/mock", "--address", address], dependencies());

    assert.equal(exitCode, 1, address);
    assert.deepEqual(await previewsFromConfig(configPath()), [], address);
    assert.deepEqual(await changingCalls(), [], address);
  }
});

test("every address form tailscale can serve is accepted", async () => {
  const addresses = ["http://127.0.0.1:80", "https://localhost:4173/app", "https+insecure://127.0.0.1:4173"];
  await configLists(addresses.map((address, index) => ({ port: 9000 + index, address })));

  assert.equal((await previewsFromConfig(configPath())).length, addresses.length);
});

test("a folder written with ~/ expands to the home folder and a relative folder is refused", async () => {
  await configLists([{ path: "/shots", folder: "~/tmp/shots" }]);
  assert.equal((await previewsFromConfig(configPath()))[0]?.folder, path.join(os.homedir(), "tmp", "shots"));

  await configLists([{ path: "/shots", folder: "tmp/shots" }]);
  await assert.rejects(previewsFromConfig(configPath()), /0\.folder: must be an absolute path/);
});

test("two entries at the same place are refused naming the second", async () => {
  const entry = { path: "/mock", address: "http://127.0.0.1:4173" };
  await configLists([entry, entry]);

  await assert.rejects(previewsFromConfig(configPath()), /1: takes a place an earlier entry already has/);
});

test("preview add edits the list and keeps every other key and comment", async () => {
  await copyFile(EXAMPLE_CONFIG, configPath());
  const original = await readFile(configPath(), "utf8");
  const originalConfig = await loadUserConfigFile(configPath(), "before");

  const exitCode = await runPreview(["add", "/mock", "--address", "http://127.0.0.1:4173"], dependencies());

  assert.equal(exitCode, 0, complaints.join("\n"));
  const edited = await readFile(configPath(), "utf8");
  const editedLines = edited.split("\n");
  let cursor = 0;
  for (const line of original.split("\n")) {
    if (line.trim() === "previews: [],") continue;
    cursor = editedLines.indexOf(line, cursor) + 1;
    assert.notEqual(cursor, 0, `lost or moved: ${line}`);
  }
  assert.ok(edited.endsWith("\n"));
  const editedConfig = await loadUserConfigFile(configPath(), "after");
  assert.deepEqual({ ...editedConfig, previews: [] }, originalConfig);
  assert.deepEqual(await previewsFromConfig(configPath()), [{ path: "/mock", address: "http://127.0.0.1:4173" }]);
  assert.deepEqual(await changingCalls(), ["serve --bg --https=443 --set-path /mock http://127.0.0.1:4173"]);
  assert.deepEqual(printed, [`https://${HOST}/mock`]);
});

test("preview add creates a file that does not exist yet holding only the list", async () => {
  const exitCode = await runPreview(["add", "8446", "--folder", "/srv/site"], dependencies());

  assert.equal(exitCode, 0, complaints.join("\n"));
  assert.deepEqual(await previewsFromConfig(configPath()), [{ port: 8446, folder: "/srv/site" }]);
  assert.deepEqual(Object.keys((await import(`${configPath()}?whole`)).default as object), ["previews"]);
  assert.deepEqual(printed, [`https://${HOST}:8446/`]);
});

test("preview add keeps the entries of a list whose key is written in quotes", async () => {
  await writeFile(configPath(), `export default { 'previews': [{ path: '/mock', address: 'http://127.0.0.1:4173' }] };\n`);

  const exitCode = await runPreview(["add", "/shots", "--address", "http://127.0.0.1:5173"], dependencies());

  assert.equal(exitCode, 0, complaints.join("\n"));
  assert.deepEqual((await previewsFromConfig(configPath())).map((entry) => entry.path), ["/mock", "/shots"]);
});

test("preview adds at the same moment all stay in the list", async () => {
  const paths = ["/a", "/b", "/c", "/d"];

  const exitCodes = await Promise.all(paths.map((place) => runPreview(["add", place, "--folder", "/srv/site"], dependencies())));

  assert.deepEqual(exitCodes, [0, 0, 0, 0], complaints.join("\n"));
  assert.deepEqual((await previewsFromConfig(configPath())).map((entry) => entry.path).sort(), paths);
});

test("preview remove takes the entry out of the same list", async () => {
  await copyFile(EXAMPLE_CONFIG, configPath());
  await runPreview(["add", "/mock", "--address", "http://127.0.0.1:4173"], dependencies());
  await runPreview(["add", "8446", "--address", "http://127.0.0.1:5173"], dependencies());
  await tailnetShows(tailnetHolding({ "/mock": { Proxy: "http://127.0.0.1:4173" } }));

  const exitCode = await runPreview(["remove", "/mock"], dependencies());

  assert.equal(exitCode, 0, complaints.join("\n"));
  assert.deepEqual(await previewsFromConfig(configPath()), [{ port: 8446, address: "http://127.0.0.1:5173" }]);
  assert.ok((await changingCalls()).includes("serve --https=443 --set-path /mock off"));
  assert.match(await readFile(configPath(), "utf8"), /THREE INDEPENDENTLY OPTIONAL TOP-LEVEL SECTIONS/);
});

test("preview list shows each entry and whether it is live", async () => {
  await configLists([
    { path: "/mock", address: "http://127.0.0.1:4173" },
    { port: 8446, address: "http://127.0.0.1:5173" },
  ]);
  await applyTheList();
  await tailnetShows(tailnetHolding({ "/mock": { Proxy: "http://127.0.0.1:4173" } }));

  const exitCode = await runPreview(["list"], dependencies());

  assert.equal(exitCode, 0, complaints.join("\n"));
  assert.deepEqual(printed, [
    `https://${HOST}/mock\tlive\thttp://127.0.0.1:4173`,
    `https://${HOST}:8446/\tnot live\thttp://127.0.0.1:5173`,
  ]);
});

test("a path this code did not create is refused and left alone", async () => {
  await configLists([]);
  const before = await readFile(configPath(), "utf8");
  await tailnetShows(tailnetHolding({ "/taken": { Proxy: "http://127.0.0.1:52000" } }));

  const exitCode = await runPreview(["add", "/taken", "--address", "http://127.0.0.1:4173"], dependencies());

  assert.equal(exitCode, 1);
  assert.match(complaints.join("\n"), /refused \/taken on port 443: held by http:\/\/127\.0\.0\.1:52000/);
  assert.equal(await readFile(configPath(), "utf8"), before);
  assert.deepEqual(await changingCalls(), []);
});

test("a port this code did not create is refused and left alone", async () => {
  await configLists([]);
  await tailnetShows(tailnetHolding({ "/": { Proxy: "http://127.0.0.1:8421" } }, 8443));

  const exitCode = await runPreview(["add", "8443", "--address", "http://127.0.0.1:4173"], dependencies());

  assert.equal(exitCode, 1);
  assert.match(complaints.join("\n"), /refused \/ on port 8443: held by http:\/\/127\.0\.0\.1:8421/);
  assert.deepEqual(await changingCalls(), []);
});

test("a listed preview on a place this code did not create is logged and left alone", async () => {
  await configLists([{ path: "/taken", address: "http://127.0.0.1:4173" }]);
  await tailnetShows(tailnetHolding({ "/taken": { Proxy: "http://127.0.0.1:52000" } }));

  await applyTheList();

  assert.deepEqual(await changingCalls(), []);
  assert.match(logged.join("\n"), /refused \/taken on port 443: held by http:\/\/127\.0\.0\.1:52000/);
});

test("removing an entry this code does not own is refused", async () => {
  await configLists([]);
  await tailnetShows(tailnetHolding({ "/taken": { Proxy: "http://127.0.0.1:52000" } }));

  const exitCode = await runPreview(["remove", "/taken"], dependencies());

  assert.equal(exitCode, 1);
  assert.match(complaints.join("\n"), /refused \/taken: it is not in the previews list/);
  assert.deepEqual(await changingCalls(), []);
});

test("a preview cannot take the /throne or /where-i-stand paths", async () => {
  await configLists([]);
  const before = await readFile(configPath(), "utf8");

  for (const reservedPath of ["/throne", "/where-i-stand"]) {
    const exitCode = await runPreview(["add", reservedPath, "--address", "http://127.0.0.1:4173"], dependencies());

    assert.equal(exitCode, 1, reservedPath);
    assert.match(complaints.at(-1)!, /0\.path: belongs to the throne's own pages/);
  }
  assert.equal(await readFile(configPath(), "utf8"), before);
});

test("a preview cannot take the root of the default tailnet port", async () => {
  for (const place of [{ path: "/" }, { port: 443 }]) {
    await configLists([{ ...place, address: "http://127.0.0.1:4173" }]);

    await assert.rejects(previewsFromConfig(configPath()), /0\.(path|port): /);
  }
});

test("a path with funnel enabled is refused", async () => {
  await configLists([]);
  const before = await readFile(configPath(), "utf8");
  await tailnetShows({
    AllowFunnel: { [`${HOST}:443`]: true },
    Web: { [`${HOST}:443`]: { Handlers: { "/open": { Proxy: "http://127.0.0.1:52000" } } } },
  });

  const exitCode = await runPreview(["add", "/open", "--address", "http://127.0.0.1:4173"], dependencies());

  assert.equal(exitCode, 1);
  assert.match(complaints.join("\n"), /refused \/open on port 443: funnel is enabled there/);
  assert.equal(await readFile(configPath(), "utf8"), before);
  assert.deepEqual(await changingCalls(), []);
  assert.equal((await tailscaleCalls()).some((call) => call.includes("funnel")), false);
});

test("a listed preview on a funnelled port is logged and never published", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173" }]);
  await tailnetShows({ AllowFunnel: { [`${HOST}:443`]: true } });

  await applyTheList();

  assert.deepEqual(await changingCalls(), []);
  assert.match(logged.join("\n"), /refused \/mock on port 443: funnel is enabled there/);
});

test("an apply waits for another apply to finish with the ledger", async () => {
  await configLists([{ path: "/mock", address: "http://127.0.0.1:4173" }]);
  await mkdir(path.dirname(ledgerPath()), { recursive: true });
  let applying: Promise<void> | undefined;

  await withExclusiveFileLock(`${ledgerPath()}.lock`, "held by this test", async () => {
    applying = applyTheList();
    await sleep(LONG_ENOUGH_FOR_AN_APPLY_TO_START_MS);
    assert.deepEqual(await tailscaleCalls(), []);
  });
  await applying;

  assert.deepEqual(await changingCalls(), ["serve --bg --https=443 --set-path /mock http://127.0.0.1:4173"]);
});

test("a preview command that makes no sense prints the usage", async () => {
  for (const commandArguments of [[], ["add"], ["list", "/mock"], ["add", "/mock", "--nonsense"]]) {
    assert.equal(await runPreview(commandArguments, dependencies()), 2, commandArguments.join(" "));
    assert.match(complaints.at(-1)!, /usage: throne preview add/);
  }
});
