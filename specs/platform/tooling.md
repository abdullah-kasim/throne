# Identity, forge and previews
Summary: Supplies the git identity, refuses orchestration words in commit and merge messages, works with pull requests, publishes tailnet previews and installs and checks pinned tools.
Code: src/git-identity, bin/git, src/forge, src/previews, src/check-jscpd, src/campaign-evidence, scripts/install-search-tools.sh, bin/rg, bin/fd
Search words: git-identity, git wrapper, --bypass, commit message, forge, preview, check-jscpd, campaign-evidence, pull request, ripgrep, rg, fd, install-search-tools

## What it does

`git-identity` prints the author from `config.user.ts`, exiting 3 when unset. `bin/git`, the `git` every agent runs, refuses with exit 65 a commit or merge message, subject or body in any case, that names an agent (`alpha-…`, `shadow-…`), the role words alpha and shadow, a step name `99a` to `99e`, conformance, verdict, "grade the", candidate or another listed ceremony word, naming the word found; a merge given no message is checked on both branch names before git writes its default subject. `git --bypass commit` or `git --bypass merge` lets the message through with one line saying so. The check that refuses an AI credit line has no bypass. `forge` handles pull requests through Forgejo when it answers, otherwise GitHub. A repository with `throne.forge.pullRequestsStayOnForgejo` true keeps its pull requests on Forgejo: GitHub holds only a mirror of main, which the landing updates. `preview` adds, removes or lists tailnet-only previews. `check-jscpd` checks the vendored jscpd pin. `campaign-evidence` generates campaign evidence.

`install.sh` runs `scripts/install-search-tools.sh`, which downloads the ripgrep and fd archives pinned under `tools.ripgrep` and `tools.fd` in `vendor-pins.json` for the host platform, refuses one whose sha256 differs from the pin, and unpacks `vendor/bin/rg` and `vendor/bin/fd`; a re-run with the pinned version present does nothing. A failed download, a hash mismatch or a platform with no pin makes the script exit 1, and `install.sh` warns and carries on. `bin/rg` and `bin/fd`, first on every agent's PATH, run the vendored binary, else the next `rg` or `fd` on PATH outside `bin/`, and exit 127 only when there is none. So pi finds them and never downloads its own copies, and `throne locate` has a real rg. Where each pin came from is in `agent_docs/search-tools.md`.

## Sub-features

- TL-IDENTITY: An unset identity exits 3.
- TL-FORGE: Merging happens only on GitHub, except where pull requests stay on Forgejo.
- TL-FORGEJO-ONLY: Where pull requests stay on Forgejo, `forge pr merge` and `forge land` squash the pull request onto `origin` main, push it to GitHub, read GitHub's main back, and only when it names the landed commit push it to Forgejo and close the Forgejo pull request; the JSON carries `mirror`. `forge promote` changes nothing and exits 0. GitHub pull request writes and review-findings refuse.
- TL-FORGE-OLD-KEY: A repository with only the old `throne.forge.landsOnMain` true is refused by every forge operation that reads the setting, naming the two rename commands.
- TL-CEREMONY: A commit or merge message naming orchestration is refused with exit 65 unless `--bypass` comes before the subcommand (`test/git-shim-refuses-ceremony-in-messages.test.ts`).
- TL-PREVIEW: Previews stay on the tailnet, never funnel.
- TL-JSCPD: jscpd on PATH must be the throne shim.
- TL-SEARCH-TOOLS: `install.sh` installs pinned, hash-checked rg and fd into `vendor/bin`, warning and carrying on when it cannot; `bin/rg` and `bin/fd` fall through to the next one on PATH when the vendored binary is missing, skipping any other copy of the same shim on PATH so two copies never call each other (`test/search-tools-shims.test.ts`).

## How to reach it and prove it works

Run `throne git-identity`; it prints the name and email from `config.user.ts` and exits 0 (3 when unset).

Run `scripts/install-search-tools.sh`, then `bin/rg --version` and `bin/fd --version`; they print the pinned versions, and a second run of the script prints only that each is already at its pin.

## Gotchas

forge falls back to GitHub through gh when Forgejo is not answering. The setting lives in each repository's untracked `.git/config`, so every machine renames it by hand.
