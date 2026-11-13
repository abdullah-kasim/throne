# The spec todo (`99bs_spec_<topic>.md`)

Always the third terminal executable todo and always a fresh real Shadow. It
runs only after explicit `99b` PASS, so the code it describes is final, and
before `99c`, so the merge slice carries code and spec together. One Shadow
writes the whole campaign's spec change; ordinary slices write none. Name the
areas the campaign touches, so the Shadow knows which spec files to bring up
to date. The procedure is `/execute-todos`' `gate-99bs-spec.md`. In `no-git`
mode it reads the change from the slices' logs alone and records the git
diff as N/A with the classifier reason.

```markdown
---
deps: [99b]
---

# 99bs — Update the spec and feature map for <feature>

Fresh spec Shadow. Follow `gate-99bs-spec.md` from `/execute-todos`.

Areas this campaign touches: <area>, <area>.

Read the campaign's whole change: `git diff <base>...HEAD` and the closing
lines of every slice's execution log. Ask `throne spec-location <repository>
--json` where the spec and the feature map are, and in what state.

For each touched area, rewrite its spec file whole so it states what the code
now does, in the form `agent_docs/spec-form.md` sets, within its size limit;
or write one line saying nothing observable changed there. Create what does
not exist yet for the touched areas only. Then regenerate the map with
`throne feature-map <spec folder>` and run `throne feature-map <spec folder>
--check`.

## Deliverable

- Every touched area has its spec file updated, or one line saying nothing
  observable changed there; a campaign that changed nothing observable says
  so in one line and changes no spec file.
- `throne feature-map <spec folder> --check` exits 0, cited with its output.
- In a repository that is ours, the spec change is committed on the campaign
  branch. In one that is not, it is written under the data home under
  `throne spec-lock --repository <repository>`, and `git status --porcelain` in the repository shows no
  file from this slice.
- End with exactly one `**Spec outcome:** PASS` or `**Spec outcome:** FAIL`.
- When you end a turn to wait on background work you started (a test or
  suite run, a monitor, a queued container slot, a background agent), end
  that message by running `throne my-state waiting-on-own-run "<what>"` and publishing
  `{"blocked":true} BLOCKED_BY_own-background-run (<what>)`; your next prompt records
  you as working again. Otherwise no-idling pages the Regent every minute.
```
