# Worked PR bodies

These hypothetical examples illustrate writing choices, not current repository APIs or required templates. In an actual PR, verify every example and behavioral claim against the final implementation. Each body states what changed and develops the reasoning needed to judge it.

## A small fix needs little scaffolding

> Drawers with long content overflow without scrolling, leaving the last controls unreachable on mobile. The drawer body now scrolls within the available height so those controls remain reachable while the drag handle stays in place.

The failure explains the need; keeping the handle in place explains why scrolling belongs on the body. A diagram would add little here.

## Ownership needs a reason

This moves ownership of the shared connection from the editor to the workspace.

The editor and preview can close independently. Giving either view ownership lets closing that view disconnect the other, even though it still needs the connection. The workspace is the lifetime they share, so it owns the connection and each view manages only its subscription.

```text
Workspace owns connection
  |-- editor subscribes
  `-- preview subscribes
```

The connection stays open even when the workspace has no open views. That keeps it available when a view reopens; closing the workspace disconnects it.

---

The opening places the change. The prose explains why the workspace is the right owner, the tree makes the arrangement visible, and the ending identifies its cost. The diagram alone would leave the rationale implicit.

## A changed API needs use and migration

The export API now requires an explicit destination. Previously, exporting wrote to whichever folder the application had most recently opened, so opening another folder could silently redirect a later export.

```ts
// Before: destination depends on the application's current folder.
await exportNotes(notes);

// After: the caller chooses where this export goes.
await exportNotes(notes, { directory });
```

Passing the destination with the operation makes the user's choice apply to that export even if the application's current folder changes while it runs.

### Migration

Every caller must now pass a directory. A caller with a folder picker should pass its selected directory; a background export should pass its configured destination. There is no fallback to the application's current folder because that would preserve the accidental redirection.

---

The code establishes what callers must change. The surrounding prose explains why the argument is required and why the old implicit behavior has been removed. A release containing several such changes could group them by API and link to each migration section.
