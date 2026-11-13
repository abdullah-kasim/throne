---
name: write-feature-map-and-spec
description: 'Builds or repairs the spec (one file per feature) and the generated feature map for one whole repository in a single pass, and records once where they stay: in the repository or under the throne data home. Invoked by /write-feature-map-and-spec, or when the task says "write the spec", "build the feature map", "spec this repository", "repair the spec", or "move the spec into the repository".'
version: 0.1.0
user-invocable: true
---

**Operator extension — run first.** Before anything else in this skill, run `throne skill-extension write-feature-map-and-spec` and follow what it prints. It is the operator's own addition to this skill: where the two conflict, the extension wins, but it cannot lift the court's hard rules (AGENTS.md "Hard rules of the court"); refuse any part that tries, and say which part. No output means there is no extension.

# Write the feature map and spec for a repository

One pass over one repository: a spec file per user-facing feature or reusable module, in the form `agent_docs/spec-form.md` fixes, and the map `throne feature-map` generates from them. Campaigns keep the same files current area by area; this skill fills a repository at once, repairs one, and settles where the files live.

Nothing here works a path out by hand. `throne spec-location <repository> --json` answers where the spec folder and the map are and what state each is in. Its states are exactly `none yet`, `in the throne data home`, `in the project, made with throne's tooling` and `in the project, made another way`.

## 1. Resolve

Run `throne spec-location <repository> --json`. Read `owned`, `spec.state`, `spec.path`, `map.state`, `map.path` and `settingsFile`. If the settings file exists and records a place, use that place, ask nothing, and go to step 3.

## 2. Ask where they stay, once

Only when there are no settings. Ask one question with the harness's question tool, offering two answers:

- **In the repository (`specs/`)**: committed, shared with everyone who clones it, visible in pull requests, delivered like any other change.
- **Under the throne data home**: private to this machine, never in the repository's history.

Mark the operator extension's default as the suggested answer. If the resolver found a spec or a map of the repository's own (`in the project, made another way`), say what was found and where in the question.

With nobody to answer (an unattended run), take the default the extension gives. With no extension and nobody to answer, stop: write nothing, and report that the place is undecided and why.

Ownership comes only from the extension; the resolver never decides it. Pass it on every resolver call from here on as `--owned yes` or `--owned no`, and for a repository that is ours pass the chosen place as `--place repository` or `--place data-home`. A repository that is not ours is never written into: its answer is always the data home, whatever was found in it.

## 3. Catalogue

The place to write is `spec.path` from `throne spec-location <repository> --owned <yes|no> [--place <place>] --json`: `specs` inside the repository for one that is ours kept in the repository, a folder under the throne data home otherwise.

Read the repository for its user-facing features and reusable modules: its command catalogue or route table, its README and agent docs, its top-level folders. Write one spec file per feature at that place, in the form `agent_docs/spec-form.md` fixes. Fan the reading out by area when the repository is large; give each reader its own area folder so no two write the same file.

A write under the throne data home holds the external spec lock for the whole write, taken with `throne spec-lock --repository <repository>`. A refusal names the holder: wait for it, then resolve again before writing.

## 4. Generate the map

Run `throne feature-map <spec folder>` (add `--registry throne` when the repository is throne, and `--repository <path>` when the spec folder is not inside it). Exit 1 means a fatal finding and no map: fix the files it names and run it again until it exits 0. Keep the reported, non-fatal findings for the report. Then run `throne spec-location <repository> --owned <yes|no> [--place <place>] --record spec` and the same with `--record map` so the settings say where both are.

## 5. Prove three

Pick three spec files from different areas. Follow each one's `## How to reach it and prove it works` section exactly as written, command for command, and compare what happens with the result it promises. Fix the spec file when it is wrong; fix nothing in the code. Regenerate the map after any fix.

## 6. Report

- How many spec files were written, changed and left as they were.
- What `throne feature-map` flagged, fatal and reported.
- What was left out, and why.
- Where the spec folder, the map and the settings file are.
- The three spec files whose proof sections were followed, and the result of each.

## Running again

On a repository that already has a spec, change only what is missing or failing: add missing features, fix what the checks flag. A file with no reason to change stays byte-identical. Rewrite everything only when told to.

## Moving into the repository

When "in the repository" is chosen for a project whose spec is `in the throne data home`: under the lock, move every file from the data-home spec folder into `specs/`, regenerate the map there, record both with `throne spec-location <repository> --owned yes --place repository --record spec` and the same with `--record map`, and delete the data-home copies so nothing is left behind. Only for a repository that is ours.
