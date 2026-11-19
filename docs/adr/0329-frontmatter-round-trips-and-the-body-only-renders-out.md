# 0329. Frontmatter round-trips, and the body only renders out

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at the word "one way," which is withdrawn for a row's values only. The folder layout, the manifest, the leave-it-alone rule, and the do-not-rewrite-matching-bytes rule are unchanged, and the body stays one way.
- **Relates:** [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md) (the split this rests on), [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) (the write direction this restores a fraction of), [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (unknown fields ride through untouched), ADR-0065 and ADR-0129 (Matter, which this does not merge with)
- **Unbuilt:** all of it, and the render it depends on is itself only partly built. Nothing watches a folder, nothing applies frontmatter to a store, and `readArtifact` is the only reader of a rendered file today, used solely to build a fresh document from a whole folder.
- **Amended by:** ADR-0337 at the return path's mechanism. A value still round-trips and a body still only renders out; what is withdrawn is the folder watcher, the per-file base store, and the application watching continuously. The base is the manifest `pull` writes, and `push` is the moment a person asks.
- **Amended by:** [ADR-0338](0338-the-folder-wins-and-a-push-is-one-approval.md) at the body's mechanism and at who is asked. This record's rule stands, and pushing is the asking: a body reaches a store only when a person asked for it. What is withdrawn is "as a whole-value replace" and the sentence that an application "must say that it replaces rather than merges": the table's codec rewrites the node the row already holds, so the node's identity and every binding to it survive, and it is the file's whole text winning rather than a merge. Also withdrawn: "a deliberate act on one row", since a push carries the whole folder after one approval rather than asking per row. The Decision's headline that a body "does not read back" goes with them.

## Context

A row is its id, its values, and exactly one node at the reserved key `content`
(ADR-0309). Those two halves have opposite economics, and every question about
how the `~/Epicenter` mirror (ADR-0271) reaches a store splits along that line.

A **value** is a map attribute that is replaced whole, so two writers touching
two different values both survive, and a redundant write is harmless. Writing a
value back from a file is a set.

A **node** is a `Y.Type` edited in place. It is why the store is a CRDT at all.
Reconciling a file's body back into one either needs a real text diff, which
nothing here imports, or degrades to
`delete(everything).insert(next)`, which discards the concurrent edits and the
undo history that made the node worth having. `apps/skills` does exactly that on
every keystroke today, which is a defect rather than a precedent.

ADR-0271 refused the whole write direction as one thing: ADR-0207's `push`,
its receipts, its scan, and its `status` verb. That apparatus was already
frontmatter-only, so what this record restores is most of its scope with less of
its machinery, and one part of it has to come back.

## Decision

**A row's values round-trip through the folder. Its body renders out and does
not read back.**

```txt
  frontmatter   two-way    a file may set a value; the store applies it
  the body      one-way    rendered from the node; never parsed back into one
```

**Writing a value back is a set, not a merge.** Values are last-writer-wins by
construction, so the return path needs no conflict resolution and no merge
algorithm. Two store writers touching two different values both survive.

**But the return path needs a base, and the base is what the file was last
rendered at.** Without one, a stale file applied whole sets every field it
carries, rolling a value back to its rendered state even though nobody edited
it. ADR-0207 named this exactly: "the receipt is the only thing that can
distinguish your edit from the state the file was rendered at." Only fields that
differ from that base are applied, and a file with no base is refused rather
than guessed at.

A file that carries a key the current declaration does not name is applied
unchanged. The store already lets unknown fields ride through writes untouched
(ADR-0240), so admitting one costs nothing it was not already carrying.

**The application owns the return path, not the host.** An application watches
its own folder and applies its own frontmatter. ADR-0226 refuses a host that
reads application data back into a store it holds; an application reading its
own folder is a different actor, and the host still holds no rows.

**A body reaches a store only as a whole-value replace, and only when a person
asked for it.** There is no automatic path from a rendered body back to a node.
An application may offer one as a deliberate act on one row, and it must say
that it replaces rather than merges.

## Consequences

- **Two kinds of application, and the row decides which one you are.**

  ```txt
  a text application    opens a folder. reads files, writes frontmatter.
                        no account, no definition, no lens, no admission.
                        an agent, a script, git, an editor, a kanban board,
                        Matter, a stranger's SPA.

  a writing application opens the store. binds an editor to the node.
                        an account, a definition, a lens, everything else.
                        Honeycrisp, and whatever comes next for writing.
  ```

  This is not a distinction between reading and writing, and not one between
  first-party and third-party. Touching `status` is a text application whether
  you are an agent or a board. Touching prose is a writing application whether
  you are Honeycrisp or a plugin.

- The blast radius of a text application is a directory, and the review tool is
  a diff. Most of what an installed application would want to do needs no
  permission model, because it never reaches a credential or a store.
- **Matter is not merged and its records are not reopened.** ADR-0065 keeps
  disk as Matter's only truth and ADR-0129 keeps the two authority policies
  apart. A two-way frontmatter is not the two substrates synchronizing; it is
  one substrate having a second front door, which a text application may open
  without knowing Epicenter exists.
- **This is not free.** A base per rendered file is a store the application has
  to keep, and losing it means refusing a file rather than guessing. That is the
  one piece of ADR-0207's apparatus this record brings back, and it is smaller
  than what stays refused: no `status` verb, no scan as a person-facing act, no
  body handling, and no conflict concept.
- The body's one-way rule is what keeps this cheap. Restoring a body return path
  means owning a text diff into node operations, and the honest floor for that
  is a real diff rather than `lib0`'s `simpleDiffString`, which is reachable as
  a transitive dependency but collapses a multi-region edit into one contiguous
  span.
- An agent cannot rewrite prose through the folder. It can propose a rewrite as
  a file, and accepting one is the whole-value replace above.

## Considered alternatives

- **Keep the folder one way.** Rejected: it makes every text application a
  read-only dashboard, which is not what any of the motivating cases were, and
  it leaves an agent with no way to act on what it just read.
- **Restore ADR-0207's full write direction.** Partly accepted rather than
  rejected, and worth stating plainly because an earlier draft of this record got
  it backwards. ADR-0207's push was frontmatter-only, so its receipts guarded
  values and never bodies. The base above is that mechanism, kept. What stays
  refused is the surrounding apparatus: a host-owned receipt store, `status` as a
  verb a person invokes, and the scan as a product surface.
- **Let the host apply frontmatter.** Rejected: that is the host reading
  application data back into a store, which ADR-0226 refuses. The application
  reading its own folder achieves the same result with the same blast radius and
  no host-owned plane.
- **Reconcile bodies with a text diff now.** Rejected as premature rather than
  wrong. No diff dependency exists, the one editor that reconstructs a node per
  keystroke is a bug to fix first, and the only working incremental binding in
  the repository is Honeycrisp's ProseMirror. Revisit when a second one exists.
