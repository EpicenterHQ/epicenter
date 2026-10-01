# 0338. File content edits the existing row node

- **Status:** Proposed
- **Date:** 2026-09-21
- **Amends:** [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the body return path: content can be edited through its codec on the existing row node.
- **Relates:** [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) defines file-versus-baseline Push and ordinary CRDT resolution.
- **Unbuilt:** Targeted text edits and the revised two-way Push path. `ContentCodec.rewrite` exists; the plain-text implementation currently clears and reinserts the body.

## Context

Markdown is an editing surface for existing rows. Replacing a row's content
node to import a file would detach editor bindings and change merge behavior.
The earlier draft coupled this useful codec boundary to a folder-wins preview
and one mandatory approval. Those interaction requirements are withdrawn.

## Decision

**A changed body edits the node the row already holds, through its codec.**

The codec owns interpretation of its content. `decode` constructs detached
content for a new row; `rewrite` edits existing content. Neither operation
replaces a document's lineage. Targeted edits should preserve unchanged content
where the codec can express them. They do not promise lossless merging of
concurrent overlapping changes.

Field changes remain ordinary per-field updates. A removed frontmatter value
uses the format's existing null representation. Parseability is distinct from
conformance to an application's current schema; this decision adds no schema
migration or automatic repair.

ADR-0418 owns the comparison: files against their materialization/submission
baseline. The folder does not receive a separate eventual-winner guarantee.
Authorization and unreadable-file policy are not codec responsibilities.

## Consequences

Keep the live content node and its bindings. Remove the old remote-conflict
preview and mandatory approval contract when implementing ADR-0418. Validate
concurrent text behavior against the pinned Yjs version rather than assuming
that a smaller diff eliminates every merge artifact.

## Considered alternatives

- Replace the content node: detaches bindings and makes whole subtrees compete.
- Clear and reinsert every body: produces edits larger than the file change.
- Guarantee that the file eventually wins: introduces a second conflict policy
  beyond ordinary synchronization.
