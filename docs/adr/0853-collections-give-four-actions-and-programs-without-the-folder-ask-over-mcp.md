# 0853. Collections give four actions, and programs without the folder ask over MCP

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is used: through actions it gives the app, not a separate data view; a collection's own `save` refuses input that does not fit, while hand edits are still never refused. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a program asking `epicenter serve` over MCP. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a program without Git asks for actions instead.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (each write is one commit), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (the five nouns, and having the folder or asking), [ADR-0857](0857-an-apps-declaration-is-plain-data-in-epicenter-json-or-epicenter-ts.md) (fields in the short form).
- **Unbuilt:** all of it.

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A person wants to browse their data
and change it, from a phone as well as a computer. A phone and a remote agent
have no folder: for them actions are the only way in, so a record they cannot
change through an action cannot be changed at all. Earlier drafts also gave
`serve` an HTTP API beside MCP, and made a standalone app such as Whispering a
screen that asked for every write.

## Decision

**Each collection gives its app four actions.** For

```ts
collections: {
  words:    { path: 'words/{stem}.md', fields: { stage: ['new', 'known'] } },
  settings: { path: 'settings.md',     fields: { dailyGoal: 'number' } },
},
```

the app gains:

```txt
vocab words list                                      every file, its fields as columns
vocab words show serendipity                          one file: its fields and its body
vocab words save serendipity --stage known            changes the fields given, keeps the rest and the body
vocab words save petrichor --stage new --body "…"     no such file yet, so it makes words/petrichor.md
vocab words delete petrichor
vocab settings show
vocab settings save --dailyGoal 20                    one file, so no list or delete
```

- The path's last placeholder is the positional of `show`, `save`, and
  `delete`, and any others are flags (`--year 2026` for
  `journal/{year}/{stem}.md`). The fields are `save`'s flags, so every program
  that asks is refused a value that does not fit before anything is written.
  `--body` replaces a Markdown file's body.
- A collection whose files are neither Markdown nor JSON holds bytes; its
  `save` takes a file and it has no fields.
- `list` and `show` are `readOnly`. `delete` is not `destructive`: the file
  stays in Git's history.
- Each `save` or `delete` is one commit (ADR-0850).
- A collection that says `readOnly: true` gives only `list` and `show`, for
  data that only the app's own actions should change.
- An app's own actions with the same words win.

**`epicenter serve` speaks MCP and nothing else**, over HTTP at its address
(MCP's Streamable HTTP transport), or over stdio with `epicenter serve --stdio`. Each
action is one MCP tool (`vocab_words_save`): its fields are the tool's input
schema, its result is structured content, and `readOnly` and `destructive` are
the tool's hints. The CLI on another computer forwards an action as a tool
call. There is no file API and no data API beside the actions.

**A page asks through a typed client.** The Epicenter app, a phone web page, or
a custom page imports an app's type (`import type`) and calls its actions over
MCP through a client in `@epicenter/app` that adds no Node or Bun code:

```ts
import type vocabApp from '~/Epicenter/vocab/epicenter.ts';
const vocab = connect<typeof vocabApp>('https://<your Epicenter>/mcp', 'vocab');
await vocab.words.save({ stem: 'serendipity', stage: 'known' });
```

The Epicenter app shows `list` and `show` as tables and detail views, and
`save` and an app's own actions as forms drawn from the tools' input schemas.

**A program with the folder writes files and commits what it wrote.**
Whispering's folder is `~/Epicenter/whispering` unless the person picks another,
which `epicenter add <folder>` links. Whispering creates it with an
`epicenter.json` declaring only collections, the shapes it writes, and a
`.gitattributes` that routes audio through LFS (ADR-0856); it writes both from a
template and reads neither back. After a take it writes the audio and its note,
and, once the folder is a Git repository, commits exactly those paths with
`git commit --only` and pushes when the branch tracks a remote. It uses the
installed `git`, because libgit2 does not run Git LFS's filters, and it never
needs `epicenter`. Every program that asks lists, reads, and edits its
recordings, and Whispering knows nothing of it. Whispering has no actions:
recording, its shortcut, and pasting need the device. Transcribing a file needs
only a key, and could become an action on your Epicenter when a program needs to
ask for it.

## Consequences

- An app with collections can be browsed and edited from any program with no
  code beyond its declaration. Hand-written actions are left for questions,
  rules across files, sign-ins, and the outside world.
- A file that must stay in step with others (an index built from pages) is not
  rebuilt by a generic `save`. Such a file is better computed by a reading
  action than stored.
- Deleted: a separate data view, an HTTP API beside MCP, a file-reading
  endpoint, a hub with its own runtime, and standalone apps as a category.
- A raw "write any file" action does not exist; a program writes through a
  collection's fields, an app's own action, or the folder itself.
- `serve` follows MCP's specification as it changes, and a byte collection's
  `save` carries its file as base64 inside a tool call.
- `epicenter mcp` becomes `epicenter serve --stdio`.

## Considered alternatives

- **Only reading actions from a collection.** Every app writes its own `add` and
  `edit`, and a phone can change only what someone wrote an action for.
- **An HTTP API beside MCP.** Two protocols to keep in step for one set of
  actions, when MCP already lists tools with input schemas and returns
  structured results.
- **The context as actions (`folder`, `secrets` exposed).** A generic file write
  skips every field and rule.
- **A standalone app that asks for every write.** It holds what it captured
  until your Epicenter confirms it, an outbox, and its core work waits on the
  network.
- **A standalone app that ships `epicenter`.** About 70 MB beside Whispering's
  31 MB (measured), to run three Git commands for files only it writes.
