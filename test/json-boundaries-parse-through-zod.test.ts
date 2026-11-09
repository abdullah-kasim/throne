import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codingPrinciplesText,
  sectionClauseProblems,
  sectionTextForHeading,
} from "./coding-principles-test-support.ts";

test("the coding principles require a new or touched JSON boundary to parse through Zod, gradually", () => {
  const section = sectionTextForHeading(
    codingPrinciplesText(),
    "## JSON boundaries parse through a Zod schema",
    "the JSON boundaries rule is present",
  );
  assert.deepEqual(
    sectionClauseProblems(section, [
      ["the rule", "Any JSON boundary that is new or being touched parses through a Zod schema, failing with the field named."],
      ["the files it covers", "`spawn.json` and ledger entries"],
      ["the commands it covers", "`gh`, Forgejo and herdr"],
      ["that it is gradual", "Do not convert existing `JSON.parse` calls in bulk."],
    ]),
    [],
  );
});
