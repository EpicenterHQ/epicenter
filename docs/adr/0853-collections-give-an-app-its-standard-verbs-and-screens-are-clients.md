# 0853. Collections give an app its standard verbs, and screens are clients

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is used: through verbs it gives the app, not a separate data view; a collection's own `save` refuses input that does not fit, while hand edits are still never refused. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a client of `epicenter serve`. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a client without Git uses verbs instead.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (each write is one commit), [ADR-0852](0852-an-app-is-a-git-repository-of-files-and-verbs.md) (files plus verbs).
- **Unbuilt:** all of it.

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A person wants to browse their data
and change it, from a phone as well as a computer. A phone and a remote agent
have no files to edit: for them, verbs are the only way in, so a record they
cannot change through a verb cannot be changed at all.

## Decision

**Each collection gives its app four verbs.** For

```ts
collections: {
  words:    { path: 'words/{stem}.md', fields: { stage: field.select(['new', 'known']) } },
  settings: { path: 'settings.md',     fields: { dailyGoal: field.number() } },
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
  `journal/{year}/{stem}.md`). The fields are `save`'s flags, so the CLI, MCP,
  and a screen's form refuse a value that does not fit before anything is
  written. `--body` replaces a Markdown file's body.
- `list` and `show` are `readOnly`. `delete` is not `destructive`: the file
  stays in Git's history.
- Each `save` or `delete` is one commit (ADR-0850).
- A collection that says `readOnly: true` gives only `list` and `show`, for
  data that only the app's own actions should change.
- An app's own actions with the same words win.

**Everything a client sees is a verb.** `epicenter serve` offers HTTP and MCP
and nothing else: no file API and no data API beside the verbs.

**A screen is a client.** The Epicenter app (a web client in a desktop window, a
phone browser, later a native phone app) shows `list` and `show` as tables and
detail views, `save` as a form, and an app's actions as forms. `serve` may host
the web client's files; the client is its own piece.

**A standalone app is a screen for one app.** It ships its own interface and
uses the device it runs on (Whispering's microphone and shortcut), and it runs
that app's verbs on your Epicenter; it never runs them itself and bundles no
Epicenter runtime. What it captures before your Epicenter confirms a verb stays
on the device. Without an Epicenter it keeps working on its own, and connecting
to one is a setting.

## Consequences

- An app with collections can be browsed and edited from any screen or agent
  with no code beyond its declaration. Hand-written actions are left for
  questions, rules across files, sign-ins, and the outside world.
- A file that must stay in step with others (an index built from pages) is not
  rebuilt by a generic `save`. Such a file is better computed by a reading
  action than stored.
- Deleted: a separate data view, a file-reading endpoint, and a hub with its own
  runtime.
- A raw "write any file" verb does not exist; writes go through a collection's
  fields or an app's own action.

## Considered alternatives

- **Only reading verbs from a collection.** Every app writes its own `add` and
  `edit`, and a phone can change only what someone wrote an action for.
- **The context as verbs (`folder`, `secrets` exposed).** A generic file write
  skips every field and rule.
- **A data API beside the verbs, or Epicenter Cloud's file API (ADR-0842).**
  Two protocols for one app.
- **A standalone app that runs verbs itself**, by bundling the `epicenter`
  binary or reimplementing the commit rule natively. A second runner per app, or
  a second implementation of the rule.
