# The 99bs spec gate

#### `99bs` — bring the spec and feature map up to date with the whole change

`99bs_spec_<topic>.md` runs third, only after explicit `99b` PASS, as one
fresh real Shadow. By then the conformance and verify gates have made their
corrections, so the spec describes what is actually delivered, and `99c` then
carries code and spec together. One writer per campaign keeps one voice in the
spec and no two Shadows on the same file. Ordinary slices write no spec; they
end their logs with two or three lines on what changed for a user or another
module, and this gate reads those lines.

1. **Read the whole change.** `git diff <base>...HEAD` on the campaign branch,
   where `<base>` is the campaign's base commit (recorded in the bundle's
   `00_overview.md` and in `tree-base.json` in the Alpha's data folder,
   `~/.throne/data/<alpha-name>/`), and the closing
   lines of every slice's execution log. List the areas the diff touches: a
   changed path belongs to the area of the spec file whose `Code:` line names
   it (an area is the first folder under the spec folder, as
   `agent_docs/spec-form.md` defines it).
2. **Ask where the spec lives.** Follow `agent_docs/spec-writing-steps.md`,
   section "Ask where the spec lives", then section "Act on the state", with
   the areas from step 1 as the areas to write. Updating in the project
   happens on the campaign branch.
3. **Rewrite, never append.** Follow `agent_docs/spec-writing-steps.md`,
   section "Rewrite, never append". An area whose change no user or module
   can observe gets one line in your report saying so, and its file is left
   alone.
4. **Regenerate and check.** Follow `agent_docs/spec-writing-steps.md`,
   section "Regenerate and check the map".
5. **Check coverage.** Every area the diff touches has its spec file updated,
   or one line saying nothing observable changed there.
6. **Commit.** In a repository that is ours, commit the spec change on the
   campaign branch. In one that is not, `git status --porcelain` in the
   repository shows nothing from this gate.

A campaign that changed nothing observable records that in one line and
changes no spec file; this gate then has no diff, and merges and reaps like
`99b` does.

End with exactly one `**Spec outcome:** PASS` or `**Spec outcome:** FAIL`.
FAIL only when the resolver or the map check refuses and you cannot repair
it; name the refusal.

#### Running again after `99c`

`99c` runs this gate's steps again, itself and before delivering, when its
merge changed code beyond a clean merge (the rule is in `gate-99c-deliver.md`),
for the areas that merge changed.
