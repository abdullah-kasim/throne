# Terminal absorb no-op provenance

`proveTerminalAbsorbNoopCompletion` accepts a terminal `99a` no-op only after
the durable records and repository history prove that the acting completion
stamp represents content retained by its supervising Alpha and that the target
was absorbed with canonical provenance.

## Preconditions shared by every accepted path

The proof fails closed unless all of these conditions hold:

- The name identifies the terminal absorb role.
- The Shadow has durable tree metadata and a durable supervising-Alpha
  identity. Its recorded merge target is that exact supervisor.
- The Shadow and Alpha metadata resolve to the same canonical repository. The
  recorded Shadow, Alpha, and target branches all exist in that repository.
- The Shadow branch advanced beyond its recorded spawn commit to a
  content-empty completion stamp. Removing that stamp exposes content that
  descends from the Shadow spawn and is retained by the current Alpha tip.
- The retained content lies on the Alpha campaign history after the Alpha's
  recorded campaign spawn. The Shadow therefore contributes no unique content
  that is absent from the Alpha.

After those checks, either of the following provenance forms is sufficient.

## Existing bounded-history form

The existing form searches the retained content's first-parent history back to
the recorded Alpha campaign spawn. It accepts a two-parent commit when its
first parent remains after that spawn and its second parent is an ancestor of
the recorded target tip. A commit with more than two parents is rejected as
ambiguous. This remains the compatibility path for canonical target absorbs
already present in the bounded campaign history.

## Direct post-stamp form

The post-stamp form examines the first commit after the retained content on the
Alpha tip's first-parent ancestry path. It accepts that direct child only when:

1. the child has exactly two parents, in this order;
2. parent one is exactly the retained content commit;
3. parent two is a member of the recorded target history; and
4. the child's tree is exactly the retained content tree.

The exact tree check makes the child a provenance-only absorb: it records the
target parent without changing the retained candidate content. The direct-child
and ordered-parent checks reject an intervening commit, reversed parents, a
foreign second parent, or a different tree.

## Compatibility boundary

The real-Git suite exercises both accepted forms: an absorb in bounded
first-parent campaign history and a direct same-tree post-stamp absorb. It also
retains the ordinary content-empty stamp path and refusal coverage for an
unperformed absorb, pre-spawn provenance, ambiguous topology, unique Shadow
content, missing durable Alpha target provenance, and a second parent outside
recorded target history. These tests establish compatibility for those measured
histories; they do not claim acceptance for untested graph shapes.

## Non-authorizations

This proof is read-only. Acceptance authorizes the existing no-op completion
exemption; it does not:

- recreate or advance a reaped acting ref;
- create a commit or synthesize missing provenance;
- mutate a target branch, the supervising Alpha branch, or any other ref; or
- mutate `alpha-conc99-suite`, `main`, or their repository state.

For a previously refused history, the required canonical commit and ref state
must already exist through separately authorized repository operations before
this proof can recognize them.
