# 0729. A link is followed only at or above a root

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md) at "Nothing is canonicalized … `root.join(path)` is opened as is": a root is resolved once when it opens, and a link inside it is refused.

## Context

ADR-0725 said the operating system follows links and that `root.join(path)`
is opened as is. The implementation does something narrower. Opening a root
resolves its path once, so a link at `~/Epicenter/whispering`, or at
`~/Epicenter` itself, reaches the folder it points to
(`packages/tauri-plugin-epicenter-folder/src/roots.rs`). Storage then walks
each relative path one name at a time without following links, and refuses a
path that passes through one (`find` in
`packages/tauri-plugin-epicenter-folder/core/src/storage.rs`). The watch does
not follow links either.

## Decision

**A link at a root's path, or above it, is followed when the root opens.**
That is how a folder lives elsewhere (ADR-0712) and how the library moves.

**A link inside a root is refused.** A read, write, listing, or watch whose
relative path passes through a link fails; no page reaches outside its root
through a link it finds there.

## Consequences

- A person or agent who places a link inside an app's folder sees that app
  refuse the path, rather than the app following it somewhere else.
- A program running as the person that swaps a directory for a link between
  the check and the open could redirect one call. A page cannot create
  links, so only a program with the person's own rights can do this.

## Considered alternatives

- **Follow links everywhere.** A link inside a folder would let a page read
  and write outside its root.
- **Refuse links at the root too.** Moving a folder or the library with a
  link, which ADR-0712 relies on, would stop working.
