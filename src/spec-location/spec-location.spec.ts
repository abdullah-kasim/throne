import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  LINKED_WORKTREE,
  NOT_OURS_EMPTY,
  NOT_OURS_OWN_MAP_NO_SPEC,
  NOT_OURS_OWN_SPEC_NO_MAP,
  OURS_EMPTY,
  OURS_WITH_THRONE_SPECS,
  OURS_WITH_WORKTREE,
  specFileText,
} from "../../scripts/spec-behaviour-evidence-fixture.mjs";
import { makeSpecFixture, type SpecFixture } from "../feature-map/spec-fixture.test-support.ts";
import {
  IN_THE_DATA_HOME,
  MADE_ANOTHER_WAY,
  MADE_WITH_THRONE,
  NONE_YET,
  plainLinesOf,
  recordSpecArtefact,
  resolveSpecLocation,
} from "./spec-location.ts";

let fixture: SpecFixture;
before(async () => {
  fixture = await makeSpecFixture();
});
after(() => fixture.remove());

const repository = (name: string) => fixture.repositories[name] as string;

test("a repository that is ours with no settings yet is answered with specs/ and specs/FEATURE_MAP.md inside it", async () => {
  const location = await resolveSpecLocation(repository(OURS_EMPTY), fixture.dataHome, true);
  assert.deepEqual(location.spec, { state: NONE_YET, path: "specs" });
  assert.deepEqual(location.map, { state: NONE_YET, path: "specs/FEATURE_MAP.md" });
});

test("a repository that is not ours with no settings yet is answered under the data home and nowhere inside it", async () => {
  const location = await resolveSpecLocation(repository(NOT_OURS_EMPTY), fixture.dataHome, false);
  assert.equal(location.spec.state, NONE_YET);
  assert.ok(location.spec.path?.startsWith(`${fixture.dataHome}/specs/`));
  assert.ok(location.map.path?.startsWith(`${fixture.dataHome}/specs/`));
});

test("without settings or an ownership answer it says ownership is unknown and names both candidate places", async () => {
  const location = await resolveSpecLocation(repository(OURS_EMPTY), fixture.dataHome);
  assert.equal(location.owned, "unknown");
  assert.equal(location.spec.path, null);
  assert.equal(location.spec.candidates?.ours, "specs");
  assert.match(plainLinesOf(location).join("\n"), /spec folder: undecided, ownership unknown/);
});

test("a worktree gets the same answer and the same settings file as its main checkout", async () => {
  const fromMain = await resolveSpecLocation(repository(OURS_WITH_WORKTREE), fixture.dataHome, true);
  const fromWorktree = await resolveSpecLocation(repository(LINKED_WORKTREE), fixture.dataHome, true);
  assert.deepEqual({ ...fromWorktree, repository: "" }, { ...fromMain, repository: "" });
  assert.equal(fromWorktree.mainCheckout, repository(OURS_WITH_WORKTREE));
});

test("a repository with specs made by throne's tooling reads as made with throne's tooling for both", async () => {
  const location = await resolveSpecLocation(repository(OURS_WITH_THRONE_SPECS), fixture.dataHome);
  assert.equal(location.spec.state, MADE_WITH_THRONE);
  assert.equal(location.map.state, MADE_WITH_THRONE);
});

test("a repository that is not ours with its own spec and no map gets the two states separately", async () => {
  const location = await resolveSpecLocation(repository(NOT_OURS_OWN_SPEC_NO_MAP), fixture.dataHome, false);
  assert.deepEqual(location.spec, { state: MADE_ANOTHER_WAY, path: "docs/specs" });
  assert.equal(location.map.state, NONE_YET);
  assert.ok(location.map.path?.startsWith(fixture.dataHome));
});

test("a repository with its own map and no spec is the mirror", async () => {
  const location = await resolveSpecLocation(repository(NOT_OURS_OWN_MAP_NO_SPEC), fixture.dataHome, false);
  assert.deepEqual(location.map, { state: MADE_ANOTHER_WAY, path: "FEATURE_MAP.md" });
  assert.equal(location.spec.state, NONE_YET);
  assert.ok(location.spec.path?.startsWith(fixture.dataHome));
});

test("after an artefact is created and recorded the next run reads the settings and no longer says none yet", async () => {
  const first = await resolveSpecLocation(repository(NOT_OURS_EMPTY), fixture.dataHome, false);
  const folder = first.spec.path as string;
  await assert.rejects(recordSpecArtefact(repository(NOT_OURS_EMPTY), fixture.dataHome, "spec", false), /does not exist yet/);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "widget.md"), specFileText({ name: "Widget", summary: "Makes widgets.", code: ["README.md"] }));
  await recordSpecArtefact(repository(NOT_OURS_EMPTY), fixture.dataHome, "spec", false);
  const second = await resolveSpecLocation(repository(NOT_OURS_EMPTY), fixture.dataHome);
  assert.deepEqual(second.spec, { state: IN_THE_DATA_HOME, path: folder });
  assert.equal(second.owned, "no");
  assert.match(await readFile(second.settingsFile, "utf8"), /"owned": false/);
});

test("a repository that is ours can keep its spec under the data home, and the next run remembers that place", async () => {
  const first = await resolveSpecLocation(repository(OURS_EMPTY), fixture.dataHome, true, "data-home");
  const folder = first.spec.path as string;
  assert.ok(folder.startsWith(`${fixture.dataHome}/specs/`));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "widget.md"), specFileText({ name: "Widget", summary: "Makes widgets.", code: ["README.md"] }));
  await recordSpecArtefact(repository(OURS_EMPTY), fixture.dataHome, "spec", true, "data-home");
  const second = await resolveSpecLocation(repository(OURS_EMPTY), fixture.dataHome);
  assert.deepEqual(second.spec, { state: IN_THE_DATA_HOME, path: folder });
  assert.ok(second.map.path?.startsWith(`${fixture.dataHome}/specs/`));
  assert.match(await readFile(second.settingsFile, "utf8"), /"place": "data-home"/);
});

test("a repository that is not ours refuses the repository as its place", async () => {
  await assert.rejects(resolveSpecLocation(repository(NOT_OURS_EMPTY), fixture.dataHome, false, "repository"), /never written into/);
});
