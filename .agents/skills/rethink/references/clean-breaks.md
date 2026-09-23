# Clean breaks

A clean break realizes the chosen destination throughout the system and retires
the shapes it supersedes. Work backward from that destination to the ownership
changes, consumer changes, and deletions needed to make it true. Use it when
replacement is within the user's requested scope.

For published APIs, deployed endpoints, on-disk data, auth state, encryption,
or sync protocols, establish the concrete migration and user consequences.
Ask about an unresolved consequential choice when existing authorization does
not cover it. Do not infer safe deletion from zero in-repository callers.

Work backward from the target to dependency-ordered changes. Move ownership and
callers together so a temporary implementation detail does not become a second
public model. Avoid aliases, dual readers, and fallback behavior whose only job
is to postpone an already authorized break. Keep a transition when an actual
consumer or data migration needs it, with a clear retirement condition.

For separable replacement paths, build the new path, switch consumers away from
the old path while it remains recoverable, and verify the replacement before
deleting the unused implementation. Keeping unused code briefly provides a
rollback point; it does not require exposing both paths to callers.

When the change cannot be separated that way, use an isolated checkout or
another appropriate recovery point. Choose verification that exercises the
changed contract, including migration behavior where durable state is involved.
Compilation alone does not prove the replacement works.

After deletion, search for old names, imports, fixtures, examples, and guidance.
Update the records that teach the current model. Check that consumers reach the
intended owner and that no hidden compatibility path has survived the change.

Compare the completed behavior with the accepted destination and the qualities
that made it worth pursuing. Resolve failures within the authorized work. When
a discovery changes the destination, return to
[dialectic](../../../skills/dialectic/SKILL.md) with the consequence made concrete
and work backward from the revised direction.
