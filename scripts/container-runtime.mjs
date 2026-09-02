// The one place the suite scripts learn which OCI runtime this host has and
// how its CLI differs. docker and podman share the surface the suite needs
// (build, run, image ls, ps, rm) but not its edges, and every edge is
// bridged here rather than in a caller:
//
//   - user mapping: podman's `--userns=keep-id` keeps the container process
//     at the host uid (the tmpfs concurrency guard accounts quota by host
//     uid); docker has no keep-id and gets `--user <uid>:<gid>` instead.
//   - image presence: `image exists` is podman-only; `image ls --quiet
//     <ref>` prints the id or nothing on both.
//   - `ps --format json`: podman prints one JSON array with `Names` as an
//     array and `StartedAt` as epoch seconds; docker prints one JSON object
//     per line with `Names` as a string and `CreatedAt` as text.
//
// Detection order matches install.sh and systemd/ntfy-serve: an explicit
// THRONE_CONTAINER_RUNTIME, then docker, then podman.
import { spawnSync } from "node:child_process";

export const CONTAINER_RUNTIME_ENV_VAR = "THRONE_CONTAINER_RUNTIME";
export const SUPPORTED_CONTAINER_RUNTIMES = Object.freeze(["docker", "podman"]);

/**
 * The suite image bakes in x86_64 bun and herdr binaries at pinned
 * checksums, so it is built and run as linux/amd64 everywhere — a no-op on
 * an amd64 host, emulation (Rosetta / qemu) on an arm64 one.
 */
export const SUITE_CONTAINER_PLATFORM = "linux/amd64";

export function commandExistsOnPath(command, spawn = spawnSync) {
  const probe = spawn("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

export function resolveContainerRuntimeName(
  env = process.env,
  commandExists = commandExistsOnPath,
) {
  const override = env[CONTAINER_RUNTIME_ENV_VAR]?.trim();
  const candidates = override ? [override] : [...SUPPORTED_CONTAINER_RUNTIMES];
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  throw new Error(
    override
      ? `container-runtime: ${CONTAINER_RUNTIME_ENV_VAR}=${override} is not on PATH`
      : `container-runtime: no container runtime found on PATH (looked for ${SUPPORTED_CONTAINER_RUNTIMES.join(", ")}); the suite runs inside a container. Install Docker or podman, or set ${CONTAINER_RUNTIME_ENV_VAR}=<name>.`,
  );
}

let resolvedRuntimeName;
/** Resolved once per process; the test seam is the explicit-argument form above. */
export function containerRuntime() {
  resolvedRuntimeName ??= resolveContainerRuntimeName();
  return resolvedRuntimeName;
}

export function containerRunUserArguments(runtime, { uid, gid }) {
  return runtime === "podman" ? ["--userns=keep-id"] : ["--user", `${uid}:${gid}`];
}

export function containerImageExists(runtime, imageReference, spawn = spawnSync) {
  const result = spawn(runtime, ["image", "ls", "--quiet", imageReference], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `container-runtime: ${runtime} image ls failed for ${imageReference} (exit ${result.status}): ${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim() !== "";
}

/** Accepts podman's single JSON array or docker's newline-delimited objects. */
export function parseContainerListJson(stdout) {
  const text = stdout.trim();
  if (text === "") return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function firstName(names) {
  if (Array.isArray(names)) return names[0] ?? "";
  if (typeof names === "string") return names.split(",")[0]?.trim() ?? "";
  return "";
}

function startedAtIso(row) {
  if (typeof row.StartedAt === "number") {
    return new Date(row.StartedAt * 1000).toISOString();
  }
  if (typeof row.CreatedAt === "string") {
    // docker: "2026-09-02 10:21:37 +0800 +08" — the trailing zone
    // abbreviation is not parseable; the numeric offset before it is.
    const parsed = Date.parse(row.CreatedAt.split(" ").slice(0, 3).join(" "));
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

/** `{ name, startedAt }` from either runtime's `ps --format json` row. */
export function normalizeContainerRow(row) {
  return { name: firstName(row?.Names), startedAt: startedAtIso(row ?? {}) };
}

export function listContainersMatchingName(runtime, namePrefix, spawn = spawnSync) {
  const result = spawn(
    runtime,
    ["ps", "--all", "--filter", `name=${namePrefix}`, "--format", "json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `container-runtime: ${runtime} ps failed while listing containers named ${namePrefix}* (exit ${result.status}): ${result.stderr ?? ""}`,
    );
  }
  return parseContainerListJson(result.stdout).map(normalizeContainerRow);
}
