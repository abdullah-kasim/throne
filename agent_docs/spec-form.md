# The spec form

A repository's spec is a folder of Markdown files, one per feature or module, with a generated index beside them. The code is the truth and the spec is its record. Every spec is treated as agent-written.

Where the folder and the index are, and what state each is in, is answered by `throne spec-location <repository>`; nothing works the path out by hand. The index is built and the set is checked by `throne feature-map <spec folder>`.

## The folder

```
specs/
  README.md          the index README: what the spec covers and how it is laid out
  ERRATA.md          places where the code and the spec knowingly disagree, one entry each
  FEATURE_MAP.md     generated; never edited by hand
  <area>/<feature>.md
```

The folder directly under the spec folder is the feature's area. A spec file at the top of the folder belongs to the area `general`. `README.md`, `ERRATA.md` and `FEATURE_MAP.md` at the top are not spec files.

## A spec file

The first four lines are the header, in this order:

```
# <feature name>
Summary: <one sentence on what it does>
Code: <path>, <path>
Search words: <word>, <word>
```

Code paths are relative to the repository root and must exist. Then these four sections, each a `##` heading spelled exactly so:

- `## What it does`
- `## Sub-features`, one list item per sub-feature in the form `- <ID>: <text>`. An ID is short and stable, and unique across the whole spec.
- `## How to reach it and prove it works`: the user's path, the exact commands that exercise it, and the result that shows it is right.
- `## Gotchas`

There is no wording or style rule. The header, the sections and the size limit are the only shape the form imposes.

## The size limit

A spec file is at most **300 lines**; a longer one fails the check and is split into smaller features. Sized from throne's largest area: the delivery gate's procedure (`gate-99c-deliver.md`) is about 570 lines, and a spec states what a feature does and how to prove it, not the step-by-step procedure, so it comes to roughly half of that and fits; a feature that does not fit is two features.

## The checks

`throne feature-map` refuses to write the map, and exits 1, when a spec file lacks the header, misses a fixed section, is over the size limit, or names a code path that does not exist, or when two spec files share a feature name or a sub-feature ID. It reports, without failing, two spec files that claim the same code path (or one inside the other), since two features may share a module; and, with `--registry throne`, every throne command that no spec claims, since a partial spec is normal while it is built lazily.

**Claimed:** a registry entry is claimed when its exact name is one of a spec file's search words.

## What counts as a spec or map of its own

A repository that is not in throne's form may already have its own. `throne spec-location` looks, in this order, for a spec folder at `specs/`, `spec/` or `docs/specs/` holding at least one Markdown spec file, and for a map at `specs/FEATURE_MAP.md`, `FEATURE_MAP.md` or `docs/FEATURE_MAP.md`. A folder whose spec files all carry the header above, and a map that starts with the generator's first lines, are "made with throne's tooling"; anything else found there is "made another way".
