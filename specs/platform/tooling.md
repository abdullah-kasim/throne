# Identity, forge and previews
Summary: Supplies the git identity, works with pull requests, publishes tailnet previews and checks pinned tools.
Code: src/git-identity, src/forge, src/previews, src/check-jscpd, src/campaign-evidence
Search words: git-identity, forge, preview, check-jscpd, campaign-evidence, pull request

## What it does

`git-identity` prints the author from `config.user.ts`, exiting 3 when unset. `forge` handles pull requests through Forgejo when it answers, otherwise GitHub. A repository with `throne.forge.pullRequestsStayOnForgejo` true keeps its pull requests on Forgejo: GitHub holds only a mirror of main, which the landing updates. `preview` adds, removes or lists tailnet-only previews. `check-jscpd` checks the vendored jscpd pin. `campaign-evidence` generates campaign evidence.

## Sub-features

- TL-IDENTITY: An unset identity exits 3.
- TL-FORGE: Merging happens only on GitHub, except where pull requests stay on Forgejo.
- TL-FORGEJO-ONLY: Where pull requests stay on Forgejo, `forge pr merge` and `forge land` squash the pull request onto `origin` main, push it to GitHub, read GitHub's main back, and only when it names the landed commit push it to Forgejo and close the Forgejo pull request; the JSON carries `mirror`. `forge promote` changes nothing and exits 0. GitHub pull request writes and review-findings refuse.
- TL-FORGE-OLD-KEY: A repository with only the old `throne.forge.landsOnMain` true is refused by every forge operation that reads the setting, naming the two rename commands.
- TL-PREVIEW: Previews stay on the tailnet, never funnel.
- TL-JSCPD: jscpd on PATH must be the throne shim.

## How to reach it and prove it works

Run `throne git-identity`; it prints the name and email from `config.user.ts` and exits 0 (3 when unset).

## Gotchas

forge falls back to GitHub through gh when Forgejo is not answering. The setting lives in each repository's untracked `.git/config`, so every machine renames it by hand.
