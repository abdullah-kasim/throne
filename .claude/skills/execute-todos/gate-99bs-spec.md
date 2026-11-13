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
   and the closing lines of every slice's execution log. List the areas the
   diff touches (an area is the first folder under the spec folder, as
   `agent_docs/spec-form.md` defines it).
2. **Ask where the spec lives.** `throne spec-location <repository> --json`.
   Never work the path out by hand. Act on its state:

   | State | Ours | Not ours |
   |---|---|---|
   | `none yet` | Create `specs/` with files for the touched areas only, and a map that says what it covers; record it with `--owned yes --record spec` and `--owned yes --record map` | The same under the data-home path the resolver names, written under `throne spec-lock --repository <repository>`; record it with `--owned no --record spec` and `--owned no --record map`; no file in the repository |
   | `in the throne data home` | Update it there under `throne spec-lock --repository <repository>` | The same |
   | `in the project, made with throne's tooling` | Update it on the campaign branch | Not reached: a repository that is not ours is never written |
   | `in the project, made another way` | Update it by the rules recorded for it | Write ours under the data home under `throne spec-lock --repository <repository>`, citing their files |

3. **Rewrite, never append.** Each spec file you touch is rewritten whole so
   it states what the code now does: no "update:" paragraph added to the end,
   and still within the form's size limit. An area whose change no user or
   module can observe gets one line in your report saying so, and its file is
   left alone.
4. **Regenerate and check.** `throne feature-map <spec folder>` (add
   `--repository <checkout>` for a data-home folder), then
   `throne feature-map <spec folder> --check`. It must exit 0.
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
