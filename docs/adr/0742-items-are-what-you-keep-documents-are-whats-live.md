# 0742. Items are what you keep; documents are what's live

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) at how an app chooses between its two stores and at the assignment `document Tabs (saved tabs)`: what a person keeps is items in a collection, a document holds only live state whose value is being current, and Tabs is a collection ([ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md)).
- **Relates:** [ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md) (co-editing apps are document apps), [ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md) (`epicenter get` and `epicenter set`), [ADR-0450](0450-current-files-own-portable-document-data.md) (a file must not become a temporary representation imported into another authority), [ADR-0739](0739-a-document-body-uses-a-standard-codec-until-an-app-needs-its-own.md) (document bodies), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state).
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at the document store: the folder is the only kind of store.

## Context

[ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) gave an app two
stores: a folder of Markdown files with history in Git, and a Yjs document
synced through the person's account. It chose between them by where an app
runs. Tabs became the one document app because it runs as a browser
extension, a browser folder never syncs, and an online variant needs a
connection for every write.
[ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md) added a
second reason: people editing one item at the same moment.

A contract names its data in `collections` (`defineContract`,
`@epicenter/definition/contract`), each with a path template such as
`recordings/{id}.md`. The code calls each Markdown file a note (`isNotePath`
in `packages/definition/src/contract/storage.ts`).

Data in a document gives up what files give. An agent reaches it only through
`epicenter get` and `epicenter set`
([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)),
never with `grep` or a file edit. Its history is the CRDT's update log, not
`git log`. Its deleted content stays as tombstones until a rebuild
([ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md)).
A saved tab is something a person keeps to come back to, and in a document
it pays all three costs to work offline in a browser.

## Decision

**A collection holds items, and an item is one Markdown file.** Its fields
are in front matter and its body follows. Prose says "item"; code may still
say "note". A collection lives in an app's folder at its contract's path
template:

```txt
~/Epicenter/whispering/        the app's folder
  recordings/                  a collection
    <id>.md                    an item: fields in front matter, then the body
    <id>.webm                  a file attached to the item (Git LFS)
```

**A document holds live state whose value is being current.** A shared
whiteboard while people draw on it, a text two people draft at the same
time, and who is looking at what right now.

**The test is whether you would want it in your history a year from now.**
If yes, it is an item. If no, it is live state, and a version worth keeping
is exported as items ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)).

| Data | In your history a year from now? | Store |
| --- | --- | --- |
| a recording and its transcript | yes | an item in `recordings` |
| a saved tab | yes | an item in `tabs` ([ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md)) |
| a task, a time block | yes | an item |
| strokes on a whiteboard as three people draw | no; the finished board, yes, exported as an item | a document |
| who has a note open right now | no | a document |

**No app has live state today.** The document store stays decided
([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md),
[ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md),
[ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md),
[ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md),
[ADR-0739](0739-a-document-body-uses-a-standard-codec-until-an-app-needs-its-own.md))
and unbuilt until the first app with live state. Every current app keeps its
data in collections, Tabs, Tasks and Timebox included.

**`epicenter checkout` and `epicenter apply` bridge agents to documents
only, never to items.** An item is already the file an agent edits. No
command writes items into another form for an agent and applies its edits
back: a file must not become a temporary representation imported into
another authority ([ADR-0450](0450-current-files-own-portable-document-data.md)).
`checkout` and `apply` stay deferred behind `get` and `set`
([ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md)).

## Consequences

- Every current app's data is files: `grep`, `git log -p`, and an agent's
  file tools reach it without an export.
- The document store's costs, a second sync service with its own
  authentication, quota, and deletion
  ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)), are not
  paid until an app has live state.
- Kept data never carries tombstones or needs a rebuild.
- Working offline in a browser is no longer a reason to choose a document.
  An extension saves items through the local engine
  ([ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)).
- An app with both kinds keeps both: a whiteboard app would keep the live
  board in a document and saved boards as items, and moving one to the other
  is an export.

## Considered alternatives

- **Choose by where the app runs (ADR-0705).** Tabs went into a document
  because a browser folder does not sync, which put kept data where Git and
  agents' file tools cannot reach it.
- **`checkout` and `apply` for items too.** Makes a file a temporary copy of
  another authority, the design ADR-0450 and
  [ADR-0534](0534-data-folders-are-the-only-data-model.md) retired.
- **A document for every app that syncs across browsers.** The Yjs store
  ADR-0534 removed.
