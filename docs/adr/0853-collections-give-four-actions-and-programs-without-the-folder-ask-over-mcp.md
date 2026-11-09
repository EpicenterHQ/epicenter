# 0853. Collections give four actions, and programs without the folder ask over MCP

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is used: through actions it gives the app, not a separate data view; a collection's own `save` refuses input that does not fit, while hand edits are still never refused. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a program asking `epicenter serve` over MCP. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a program without the folder asks for actions instead.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0850](0850-every-writer-commits-exactly-what-it-wrote.md) (each write is a commit), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0857](0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md) (fields and annotations).
- **Unbuilt:** all of it except MCP over stdio. The four collection actions, the handles, and the typed client come with the first app that needs them (Vocab).

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A person wants to browse their data
and change it, from a phone as well as a computer. A phone and a remote agent
have no folder: for them actions are the only way in, so a record they cannot
change through an action cannot be changed at all. Earlier drafts also gave
`serve` an HTTP API beside MCP.

## Decision

**Each collection gives its app four actions.** For a collection `words` with
path `words/{stem}.md` and a `stage` field that is one of `new` or `known`:

```txt
vocab words list                                      every file, its fields as columns
vocab words show serendipity                          one file: its fields and its body
vocab words save serendipity --stage known            changes the fields given, keeps the rest and the body
vocab words save petrichor --stage new --body "…"     no such file yet, so it makes words/petrichor.md
vocab words delete petrichor
```

- The path's last placeholder is the positional of `show`, `save`, and `delete`.
  A path is a level-1 URI Template (RFC 6570).
- `save`'s flags are the collection's fields, so every program that asks is
  refused a value that does not fit before anything is written. `--body`
  replaces a Markdown file's body. A collection with one file and no placeholder
  gives only `show` and `save`.
- `list` and `show` are read-only. `save` and `delete` are not destructive: Git
  keeps every version.
- The same four are the handles an action's `run` receives (ADR-0857).

**`epicenter serve` speaks MCP and nothing else,** over HTTP at its address
(MCP's Streamable HTTP transport), or over stdio with `epicenter serve --stdio`.
Each action is one MCP tool (`vocab_words_save`) whose `inputSchema` comes from
its fields and whose `annotations` are its own. There is no file API and no data
API beside the actions. A page asks through a typed client in
`@epicenter/app/client`, built on `import type` of the app's `epicenter.ts`, and
the Epicenter app shows `list` and `show` as tables, and `save` and an app's
actions as forms drawn from their input schemas.

**A program with the folder writes files and commits what it wrote.** Whispering's
folder is `~/Epicenter/whispering` unless the person picks another, which
`epicenter add <folder>` links. Whispering owns its `epicenter.json`, writing it
from a template when absent and rewriting its collections when its format
changes, and its `.gitattributes`; it ignores files it does not know. After a take
it writes the audio and its note and, once the folder is a Git repository,
commits exactly those paths and pushes (ADR-0850, ADR-0851). It uses the installed
`git`, because libgit2 does not run Git LFS's filters, and it never needs
`epicenter`. Every program that asks lists, reads, and edits its recordings
without Whispering knowing. A person or agent may add an `epicenter.ts` to the
folder with actions and collections of their own (ADR-0857). Recording, the
shortcut, and pasting need the device and are never actions.

## Consequences

- An app with collections can be browsed and edited from any program with no
  code beyond its declaration. Hand-written actions are left for questions,
  rules across files, sign-ins, and the outside world.
- A file that must stay in step with others (an index built from pages) is not
  rebuilt by a generic `save`; such a file is better computed by a reading action
  than stored.
- Deleted: a separate data view, an HTTP API beside MCP, a file-reading endpoint,
  a hub with its own runtime, and standalone apps as a category.
- `serve` follows MCP's specification as it changes.
- `epicenter mcp` becomes `epicenter serve --stdio`.

## Considered alternatives

- **Only reading actions from a collection.** Every app writes its own `add` and
  `edit`, and a phone can change only what someone wrote an action for.
- **An HTTP API beside MCP.** Two protocols to keep in step for one set of
  actions.
- **The context as actions (`folder`, `secrets` exposed).** A generic file write
  skips every field and rule.
- **A standalone app that asks for every write.** It holds what it captured
  until your Epicenter confirms it, an outbox, and its core work waits on the
  network.
- **A standalone app that ships `epicenter`.** About 70 MB beside Whispering's
  31 MB (measured), to run three Git commands for files only it writes.
- **Read-only collections, collections of uploaded files, and two-placeholder
  paths.** No app needs them yet; each returns with the first app that does.
