# The spec-writing steps

The steps every writer of a spec follows, whether it fills a whole repository or brings the areas one campaign touched up to date. What the files look like is `agent_docs/spec-form.md`; it is not repeated here. Which files to write, when, and what to report belong to the procedure that sent you here.

## Ask where the spec lives

Run `throne spec-location <repository> --json`. Never work a path out by hand. Read `owned`, `spec.state`, `spec.path`, `map.state`, `map.path` and `settingsFile`. The states are exactly `none yet`, `in the throne data home`, `in the project, made with throne's tooling` and `in the project, made another way`.

The resolver never decides ownership. When the settings do not record it, pass `--owned yes` or `--owned no` on every call, and for a repository that is ours pass the place as `--place repository` or `--place data-home` (the repository when left out). `spec.path` is null until ownership is known: once you pass `--owned`, run the resolver again and use the `spec.path` it then prints. A repository that is not ours is never written into: its place is always the data home, whatever was found in it.

## Act on the state

| State | Ours | Not ours |
|---|---|---|
| `none yet` | Create `specs/` with files for the areas you were sent to write, and a map that says what it covers; record it (section "Record the place") | The same under the data-home path the resolver names, written under the lock (section "Hold the lock"); record it; no file in the repository |
| `in the throne data home` | Update it there under the lock | The same |
| `in the project, made with throne's tooling` | Update it in the repository, on the branch the change is delivered from | Not reached: a repository that is not ours is never written |
| `in the project, made another way` | Update it by the rules recorded for it | Write ours under the data home under the lock, citing their files |

## Hold the lock

Every write under the throne data home, the spec files and the map alike, holds `throne spec-lock --repository <repository>` for the whole write. The command keeps the lock until it is stopped (TERM or INT) or its `--ttl` ends (default 5m, at most 15m), so start it in the background, edit only while it prints `locked by`, and stop it when the write is done. Make the `--record` calls (section "Record the place") before you stop it: they rewrite the settings file in the very folder the lock guards, and do not take the lock themselves. A second writer is refused at once with exit 1, naming the holder: wait for that holder to finish, then ask where the spec lives again before writing. A write inside the repository takes no lock.

## Record the place

Once a spec folder or a map exists at a place the settings do not yet record (it was `none yet`, or it moved), run `throne spec-location <repository> --owned <yes|no> [--place <place>] --record spec` and the same with `--record map`. Recording refuses a file that does not exist yet, so create it first. Ownership is saved only together with `--record`; a resolver call with `--owned` alone writes nothing.

## Rewrite, never append

Each spec file you touch is rewritten whole so it states what the code now does: no "update:" paragraph added to the end, and still within the form's size limit. A file with no reason to change stays byte-identical.

## Regenerate and check the map

Run `throne feature-map <spec folder>`, adding `--registry throne` when the repository is throne and `--repository <path>` when the spec folder is not inside the repository (a data-home folder). Exit 1 means a fatal finding and no map: fix the files it names and run it again. Keep the reported, non-fatal findings for your report. Then run `throne feature-map <spec folder> --check` with the same `--repository` flag; it must exit 0.

## Form rules these steps enforce

Rules about the form that a writer must apply while following these steps, beyond what `agent_docs/spec-form.md` and `throne feature-map` already check. None yet.
