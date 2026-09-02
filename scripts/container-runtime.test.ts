import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageExists,
  containerRunUserArguments,
  listContainersMatchingName,
  normalizeContainerRow,
  parseContainerListJson,
  resolveContainerRuntimeName,
} from "./container-runtime.mjs";

test("the runtime is the explicit override, else docker, else podman", () => {
  const onPath = (names: string[]) => (command: string) => names.includes(command);
  assert.equal(resolveContainerRuntimeName({}, onPath(["docker", "podman"])), "docker");
  assert.equal(resolveContainerRuntimeName({}, onPath(["podman"])), "podman");
  assert.equal(
    resolveContainerRuntimeName({ THRONE_CONTAINER_RUNTIME: "podman" }, onPath(["docker", "podman"])),
    "podman",
  );
  assert.throws(
    () => resolveContainerRuntimeName({ THRONE_CONTAINER_RUNTIME: "nerdctl" }, onPath(["docker"])),
    /THRONE_CONTAINER_RUNTIME=nerdctl is not on PATH/,
  );
  assert.throws(() => resolveContainerRuntimeName({}, onPath([])), /no container runtime found/);
});

test("podman keeps the host uid through keep-id; docker gets an explicit --user", () => {
  assert.deepEqual(containerRunUserArguments("podman", { uid: 501, gid: 20 }), ["--userns=keep-id"]);
  assert.deepEqual(containerRunUserArguments("docker", { uid: 501, gid: 20 }), ["--user", "501:20"]);
});

test("image presence is read from `image ls --quiet` on both runtimes", () => {
  const calls: unknown[][] = [];
  const spawn = (stdout: string) => ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    return { status: 0, stdout, stderr: "" };
  }) as never;
  assert.equal(containerImageExists("docker", "localhost/throne-suite-app:abc", spawn("deadbeef\n")), true);
  assert.equal(containerImageExists("podman", "localhost/throne-suite-app:abc", spawn("")), false);
  assert.deepEqual(calls[0], ["docker", "image", "ls", "--quiet", "localhost/throne-suite-app:abc"]);
  assert.throws(
    () => containerImageExists("docker", "x", ((() => ({ status: 1, stdout: "", stderr: "daemon down" })) as never)),
    /docker image ls failed for x \(exit 1\): daemon down/,
  );
});

test("`ps --format json` is parsed whether it is podman's array or docker's line-delimited objects", () => {
  const podman = JSON.stringify([
    { Names: ["throne-suite-app-abc"], StartedAt: 1_788_316_000 },
  ]);
  const docker =
    '{"Names":"throne-suite-app-abc","CreatedAt":"2026-09-02 10:21:37 +0800 +08"}\n' +
    '{"Names":"other,alias","CreatedAt":"2026-09-02 10:22:00 +0800 +08"}\n';
  assert.deepEqual(parseContainerListJson("").length, 0);
  assert.deepEqual(parseContainerListJson(podman).map(normalizeContainerRow), [
    { name: "throne-suite-app-abc", startedAt: "2026-09-02T02:26:40.000Z" },
  ]);
  assert.deepEqual(parseContainerListJson(docker).map(normalizeContainerRow), [
    { name: "throne-suite-app-abc", startedAt: "2026-09-02T02:21:37.000Z" },
    { name: "other", startedAt: "2026-09-02T02:22:00.000Z" },
  ]);
  assert.deepEqual(normalizeContainerRow({ Names: ["x"], CreatedAt: "garbage" }), {
    name: "x",
    startedAt: undefined,
  });
});

test("listing containers by name prefix passes the filter through and normalizes rows", () => {
  let seen: string[] = [];
  const rows = listContainersMatchingName(
    "podman",
    "throne-suite-app-abc",
    ((command: string, args: string[]) => {
      seen = [command, ...args];
      return { status: 0, stdout: JSON.stringify([{ Names: ["throne-suite-app-abc"], StartedAt: 1 }]), stderr: "" };
    }) as never,
  );
  assert.deepEqual(seen, ["podman", "ps", "--all", "--filter", "name=throne-suite-app-abc", "--format", "json"]);
  assert.equal(rows[0]?.name, "throne-suite-app-abc");
  assert.throws(
    () => listContainersMatchingName("docker", "x", ((() => ({ status: null, stdout: "", stderr: "" })) as never)),
    /docker ps failed while listing containers named x\*/,
  );
});
