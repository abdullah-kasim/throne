# Public-release hygiene — this repo is machine- and project-agnostic

Everything written into this repo must be machine-agnostic and project-agnostic
— it is bound for public release. When an example comes from real private work
(a client, a device, a codename, a filesystem path), generalise it BEFORE
writing it down: keep the SHAPE of the example, change the domain. The shape is
what teaches; the domain is what leaks. Use `/home/example`-style paths, and
pick a domain any reader recognises. `npm test` runs `lint:private-refs`, but
that is a backstop for identifiers we already know about — it cannot catch a
private name nobody has banned yet. You are the check for anything new.

This governs THIS repo only — dotfiles and `~/.memories/` keep their specifics
and are never published. Generalising must not gut the lesson: keep the
argument the example was making intact under the new domain.

The backstop itself, `scripts/lint-private-refs.sh`, carries zero private
strings of its own — it reads its pattern list from an external file outside
the repo (`${THRONE_PRIVATE_REFS:-$HOME/.config/throne/private-refs.txt}`) so
the guard is never itself an inventory of what it's hiding. No file present
means the check skips green; a public clone stays green with no configuration.
