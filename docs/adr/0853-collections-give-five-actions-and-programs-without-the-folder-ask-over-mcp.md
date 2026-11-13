# 0853. Collections give five actions, and programs without the folder ask over MCP

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is used: through actions it gives the app, not a separate data view; a collection's own `save` refuses input that does not fit, while hand edits are still never refused. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a program asking `epicenter serve` over MCP. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a program without the folder asks for actions instead.
- **Relates:** [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md) (why `edit` quotes the passage it replaces), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (fields, annotations, and how an app places its verbs), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (where Whispering's files and state live), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, and clients that ask).
- **Unbuilt:** `epicenter serve` over HTTPS. Built: each collection's `list`, `get`, `add`, `set`, `edit`, and `delete` from the command line and over `epicenter serve` (`packages/app/src/collection.ts`), the collection's methods inside a run, a written action replacing a verb by its key, and the client `connect`, typed by the app (`packages/app/src/client.ts`).

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A person wants to browse their data
and change it, from a phone as well as a computer. A phone, a browser, and a
remote agent have no folder (ADR-0864): for them actions are the only way in, so
a record they cannot change through an action cannot be changed at all. Earlier
drafts also gave `serve` an HTTP API beside MCP.

## Decision

**Each collection gives its verbs as actions.** For a collection `words` with
path `words/{word}.md` and a `stage` field that is one of `new` or `known`, in
an app that keeps its verbs under its name:

```txt
vocab words list                                           every file: its path and fields
vocab words get words/serendipity.md                       one file: its fields and its body
vocab words add petrichor --stage new --body "…"           makes words/petrichor.md; refused when one is there
vocab words set words/serendipity.md --stage known         changes the fields given, keeps the rest and the body
vocab words edit words/petrichor.md --old "…" --new "…"    replaces one passage of the body, quoted
vocab words delete words/petrichor.md
```

- The verbs are `Map`'s and Deno KV's, `list`, `get`, `set`, `delete`, with
  `add` to make a file and `edit` for prose (ADR-0869). They read the same in
  a terminal, in an MCP tool name (`vocab_words_set`), and in code
  (`words.set(path, { stage })` in an action, `app.words.set({ path, stage })`
  in a UI).
- A file's address is its path inside the app (`words/serendipity.md`), which
  `get`, `set`, `edit`, and `delete` take first, by position on the command
  line. Each placeholder but `{time}` is an input `add` takes by position;
  `add` makes `{time}` itself (ADR-0857).
- `add`'s and `set`'s flags are the collection's fields, so every program that
  asks is refused a value that does not fit before anything is written.
  `--body` gives a new file its body; a body already there is changed with
  `edit`, which quotes the passage it replaces and is refused when that
  passage is not there exactly once (ADR-0869). `set` merges, as Firestore's
  `set(…, { merge: true })` does, not as `Map.set` replaces: a person changing
  one field from a terminal keeps the others and the body. A collection with
  one file and no placeholder gives only `get`, `set`, and `edit`, and its
  first `set` makes the file.
- `list` and `get` are read-only, and `add` is not destructive. `set`, `edit`,
  and `delete` keep MCP's default, destructive: each write is a commit
  (ADR-0850), but an app outside a Git repository commits nothing, and there
  the value they replace is gone.

**An app's tools are the actions `defineApp` composes (ADR-0857).** Actions
nest: a key holds an action or a group of them. A collection gives its verbs
through `words.actions()`, and the app places them: under the collection's
name (`words: words.actions()`), or spread at the top when it has one
collection, so they are its own. A written action under the same key replaces
a verb (a `set` that checks a rule across files), a new key joins the group
(`archive`), and naming verbs gives fewer (`words.actions('list', 'get')` for
a collection only the app's own actions write). The words are one name
everywhere:

```txt
definition   actions: { words: { ...words.actions(), archive } }
terminal     epicenter vocab words archive
MCP          vocab_words_archive
client       app.words.archive(…)
```

Each word is lowercase letters, digits, and dashes (`summarize-week`), the
same in code, on the command line, and over MCP. Inside an action, the
collection's methods (`words.list()`, `words.get(path)`, `words.add(…)`,
`words.set(path, fields)`, `words.edit(path, change)`, `words.delete(path)`)
read and write the run's folder.

**`epicenter serve` speaks MCP,** over HTTPS at `/` (MCP's Streamable HTTP
transport), or over stdio with `epicenter serve --stdio`. Each action is one
MCP tool (`vocab_words_set`) whose `inputSchema` comes from its fields and
whose `annotations` are its own. There is no file API and no data API beside
the actions. Beside MCP, `serve` answers only its own paths, which start with
`.` (sign-in, when it comes), and each app's view as static files at
`/<app>/` (ADR-0864).

**A view asks through `connect` in `@epicenter/app/client`,** which posts
MCP's `tools/call` to the same origin's `/` and names the action by its
words (ADR-0860). It is typed by the app, which the view imports as a type
only, so its bundle carries no app code. Vocab has one collection, so its
verbs are its own:

```ts
import { connect } from '@epicenter/app/client';
import type vocab from '../../../epicenter.js';

const app = connect<typeof vocab>();
await app.get({ path: 'words/你好.md' });                    // the tool vocab_get
await app.review({ path: 'words/你好.md', grade: 'good' });  // the tool vocab_review
```

The client reads the app's name from the first path segment of the UI's URL;
`import type` leaves no name at run time. One name has three spellings:
`vocab review` in a terminal, `vocab_review` over MCP, `app.review` in the
client.

**A program with the folder writes files and commits them.** Whispering's
folder is `~/Whispering`, and its contract is the `epicenter.ts` of its
starter, which a person installs as the `whispering` app ([ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md)). After a
recording it writes its note and audio, the audio named `<id>.local.<ext>`
when the person keeps it on that computer (ADR-0858). Once connected, its
folder is a clone of the app's data repository: it commits those paths and
pushes them to the Studio when it can ([ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md)). It never needs `epicenter`.
Every program that asks lists, reads, and edits its recordings on your
server without Whispering knowing. Recording, the shortcut, and pasting need the device and are never
actions.

## Consequences

- An app with collections can be browsed and edited from any program with no
  code beyond its collections' definitions. Hand-written actions are left for questions,
  rules across files, sign-ins, and the outside world.
- A file that must stay in step with others (an index built from pages) is not
  rebuilt by a generic `set`; such a file is better computed by a reading action
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
  until your server confirms it, an outbox, and its core work waits on the
  network.
- **A standalone app that ships `epicenter`.** About 70 MB beside Whispering's
  31 MB (measured), to run three Git commands for files only it writes.
- **Collections of uploaded files, and two-placeholder paths.** No app needs
  them yet; each returns with the first app that does. ADR-0857 later allowed
  any number of placeholders, one to a path segment.
- **`list`, `show`, `save`, `delete`.** `show` reads as printing in code, and
  `save` was a word of Epicenter's own where `Map` and Deno KV already agree on
  `get` and `set`.
- **`set` and `delete` marked not destructive because Git keeps every
  version.** True only for an app in a Git repository; one outside any
  commits nothing.
- **A written action named like a collection's is a problem.** Leaves the
  generic action callable beside the rule the written one enforces.
- **A client typed by `typeof` the module `epicenter.ts`.** While collections
  were declared in `epicenter.json`, the module's exports were only the written
  actions, and the collections' verbs would be missing. Chosen once
  `defineApp` composed every action (ADR-0857): `connect<typeof app>`.
- **Collection actions spread by hand (`...collection('words')`).** While
  collections were declared in `epicenter.json`, the same rule typed in every
  app and a second way to pass the declaration. Chosen once collections became
  values (ADR-0857): `...words.actions()`.
- **A view's client with the transport passed in: `postMessage` through a host
  that shows the view, MCP over HTTP, or stdio.** A view is a page at
  `/<app>/` on the server's own origin (ADR-0864), so one transport, `fetch` to
  `/`, is all it needs.
