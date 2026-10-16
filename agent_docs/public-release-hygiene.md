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
strings of its own. Every private term lives in one file, `publish-scrub.sed`,
found at `${PUBLISH_SCRUB_FILE:-<throne checkout>/publish-scrub.sed}`. It is
tracked in this private repository, not gitignored, and never copied into the
public snapshot (it is on `NEVER_PUBLISHED_PATHS` in
`scripts/publish-scrub-file.sh`). Its `# verify:` lines are the pattern list
for three checks: publish's own verify step on the scrubbed snapshot, this
lint on every tracked file publish could copy, and the skill-write guard on
every `SKILL.md` write. To ban a new term, add a `# verify:` line there, and a
rewrite rule when publishing must still pass. No file present means the lint
skips green; a public clone stays green with no configuration.

Before any real publish, run the `.claude/skills/publish/SKILL.md` procedure:
it reads the staged, post-scrub snapshot's prose in full (not just the
pattern list) for content that is general only in shape, fixes it at the
private source, and only then lets the real publish run.
