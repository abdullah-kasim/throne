# Finding and sifting
Summary: Ranks files and items by relevance and trims long command output to what matters.
Code: src/item-rank, src/file-locate, src/log-sift, src/jev-probe, src/relevance-classifier
Search words: rank, locate, sift, jev-probe, relevance

## What it does

`rank` orders items by how likely each answers yes to a question without printing their contents. `locate` names the files most likely to matter for a task with a probability and reason. `sift` saves full output under ~/tmp and prints only the chunks that matter. `jev-probe` asks one costed yes/no question.

## Sub-features

- FI-RANK: Ranking never prints item contents.
- FI-LOCATE: Each located file has a probability and a reason.
- FI-SIFT: The last chunk is always kept and the full copy is saved.

## How to reach it and prove it works

```
bun test ./src/log-sift/sift.command.spec.ts
```

## Gotchas

jev is slated for removal; prefer the other three.
