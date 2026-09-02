// Requirement: an omp agent's composer state can be read from its pane.
//
// omp draws its composer as a rounded box whose BOTTOM edge is the input
// line itself (`╰─ <draft> ─╯`), with the model/status breadcrumb baked
// into the box's TOP edge instead of a separate footer row — unlike
// Claude's/Codex's `❯`/`›`-marked line or opencode's `┃`-bordered box with a
// distinct model-status footer. These fixtures are real `tmux capture-pane
// -e` output from a live `bin/ompy` launch (slice 05 recon), not synthetic
// ANSI, so this exercises the real screen-observation function against
// genuine omp rendering.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import { styledLinesFromAnsi } from "../src/codex-screen/composer/ansi.ts";
import {
  activePromptMarker,
  promptMarkerCandidates,
  readPromptRegion,
} from "../src/codex-screen/composer/prompt-region.ts";
import { inspectSupportedAgentScreen } from "../src/codex-screen/composer/composer.service.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

test("an omp agent's empty composer is read as an empty draft, not a decorative box", () => {
  const ansi = readFixture("omp-live-empty-composer.ansi");
  const lines = styledLinesFromAnsi(ansi);

  // The welcome screen draws several other boxes (tips, model info) that
  // also close on a `╰` corner — only the real composer's bottom edge
  // (single dash, then a space) should survive as a candidate.
  const candidates = promptMarkerCandidates(lines, HARNESS_NAMES.OMP);
  assert.equal(candidates.length, 1);

  const marker = activePromptMarker(candidates, HARNESS_NAMES.OMP, lines);
  assert.ok(marker !== undefined);
  const region = readPromptRegion(lines, marker!, HARNESS_NAMES.OMP);
  assert.equal(region.active, true);
  assert.equal(region.text, "");

  const snapshot = inspectSupportedAgentScreen(HARNESS_NAMES.OMP, ansi);
  assert.deepEqual(snapshot.activeComposer, { state: "empty", text: "" });
});

test("an omp agent's composer state can be read from its pane", () => {
  const ansi = readFixture("omp-live-draft-composer.ansi");
  const lines = styledLinesFromAnsi(ansi);

  const candidates = promptMarkerCandidates(lines, HARNESS_NAMES.OMP);
  assert.equal(candidates.length, 1);

  const marker = activePromptMarker(candidates, HARNESS_NAMES.OMP, lines);
  assert.ok(marker !== undefined);
  const region = readPromptRegion(lines, marker!, HARNESS_NAMES.OMP);
  assert.equal(region.text, "wire up the omp composer");

  const snapshot = inspectSupportedAgentScreen(HARNESS_NAMES.OMP, ansi);
  assert.deepEqual(snapshot.activeComposer, {
    state: "draft",
    text: "wire up the omp composer",
  });
});
