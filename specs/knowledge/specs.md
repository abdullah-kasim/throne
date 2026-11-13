# Specs and feature map
Summary: Locates a repository's spec and feature map, generates the map and checks the spec set.
Code: src/spec-location, src/feature-map, src/spec-lock, agent_docs/spec-form.md, .claude/skills/write-feature-map-and-spec
Search words: spec-location, feature-map, spec-lock, spec, feature map

## What it does

`spec-location` reports where a repository's spec folder and map are and the state of each, from one settings file per project under the throne data home keyed by the main checkout; a repository that is ours keeps them in `specs/` or, with `--place data-home`, under the data home, and one that is not ours always under the data home. `feature-map` builds FEATURE_MAP.md from spec headers and runs the set checks; `--check` fails when the map on disk is stale. `spec-lock` holds the edit lock on an external spec folder.

## Sub-features

- SP-STATES: States are none yet, in the throne data home, made with throne's tooling, made another way.
- SP-WORKTREE: A worktree resolves to its main checkout's settings.
- SP-CHECKS: Missing header, section, path, size or duplicates are fatal.
- SP-REGISTRY: With --registry throne, unclaimed commands are reported.
- SP-LOCK: A second writer is refused naming the holder.

## How to reach it and prove it works

```
throne feature-map specs --check --registry throne
```

Run from the repository root: exits 0 and reports no unclaimed command. Edit any spec's summary line and run it again: it exits non-zero because the map is stale.

## Gotchas

The map is generated; editing it by hand makes `--check` fail.

