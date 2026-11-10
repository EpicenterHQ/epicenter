# 0853. Collections give four actions, and programs without the folder ask over MCP

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is used: through actions it gives the app, not a separate data view; a collection's own `save` refuses input that does not fit, while hand edits are still never refused. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a program asking `epicenter serve` over MCP. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a program without the folder asks for actions instead.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that have the folder or ask), [ADR-0857](0857-an-app-declares-itself-in-epicenter-json-and-its-code-in-epicenter-ts.md) (fields and annotations), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (where Whispering's files and state live), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, and clients that ask).
- **Unbuilt:** `collections` in `run`, groups of actions with `null` removing one, `epicenter serve` over HTTPS, and the client typed by `App`. Built: each collection's `list`, `get`, `set`, and `delete` from the command line and over `epicenter serve --stdio` (`packages/app/src/collection.ts`), a written action replacing a collection's by its words, and the untyped view client `connect` (`packages/app/src/client.ts`).

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A person wants to browse their data
and change it, from a phone as well as a computer. A phone, a browser, and a
remote agent have no folder (ADR-0864): for them actions are the only way in, so
a record they cannot change through an action cannot be changed at all. Earlier
drafts also gave `serve` an HTTP API beside MCP.

## Decision

**Each collection gives its app four actions.** For a collection `words` with
path `words/{stem}.md` and a `stage` field that is one of `new` or `known`:

```txt
vocab words list                                      every file, its fields as columns
vocab words get serendipity                           one file: its fields and its body
vocab words set serendipity --stage known             changes the fields given, keeps the rest and the body
vocab words set petrichor --stage new --body "…"      no such file yet, so it makes words/petrichor.md
vocab words delete petrichor
```

- The verbs are `Map`'s and Deno KV's: `list`, `get`, `set`, `delete`. They
  read the same in a terminal, in an MCP tool name (`vocab_words_set`), and in
  code (`collections.words.set({ stem, stage })`).
- The path's last placeholder is the key field: required, first, and so read by
  position on the command line (ADR-0857). A path is a level-1 URI Template
  (RFC 6570).
- `set`'s flags are the collection's fields, so every program that asks is
  refused a value that does not fit before anything is written. `--body`
  replaces a Markdown file's body. `set` merges, as Firestore's
  `set(…, { merge: true })` does, not as `Map.set` replaces: a person changing
  one field from a terminal keeps the others and the body. A collection with
  one file and no placeholder gives only `get` and `set`.
- `list` and `get` are read-only. `set` and `delete` keep MCP's default,
  destructive: a run from the command line commits nothing (ADR-0850), so the
  value they replace is gone unless someone committed it. Through
  `epicenter serve` each write is a commit (ADR-0864).

**An app's tools are its collections' actions, then `epicenter.ts`'s actions
on top.** Actions nest: an object with `run` is an action, and any other
object is a group of them. Each collection is a group holding its four, and
`epicenter.ts`'s object is laid over the groups one level deep. A written action
at the same path replaces the collection's (a `words.set` that checks a rule
across files), a new one joins the group (`words.archive`), and `null` removes
one (`words: { delete: null }` for a collection nobody deletes from). An app with
no `epicenter.ts` has exactly its collections' actions. The path is one name
everywhere:

```txt
definition   words.archive
terminal     epicenter vocab words archive
MCP          vocab_words_archive
client       epicenter.vocab.words.archive(…)
```

A name of more than one word is camelCase in code and kebab-case elsewhere
(`summarizeWeek`, `summarize-week`; ADR-0857). Inside `run`, the same four are
`collections.<name>.list`, `.get`, `.set`, `.delete`, bound to the run's folder.

**`epicenter serve` speaks MCP,** over HTTPS at `/` (MCP's Streamable HTTP
transport), or over stdio with `epicenter serve --stdio`. Each action is one
MCP tool (`vocab_words_set`) whose `inputSchema` comes from its fields and
whose `annotations` are its own. There is no file API and no data API beside
the actions. Beside MCP, `serve` answers only its own paths, which start with
`.` (the view client at `/.client.js`, and sign-in), and each app's `view/` as
static files at `/<app>/` (ADR-0864).

**A view asks through `connect` in `@epicenter/app/client`,** which posts
MCP's `tools/call` to the same origin's `/` and names the action by its
words (ADR-0860):

```ts
import { connect } from '@epicenter/app/client';

const vocab = connect('vocab');
await vocab.call('words get', { stem: '你好' });     // the tool vocab_words_get
await vocab.call('review', { stem: '你好', grade: 'good' });
```

A client typed by `App`, the app's whole tree of actions that `epicenter:app`
declares (its collections' groups with `epicenter.ts`'s exports laid over them;
ADR-0857), turns a property path into the tool name instead:
`createClient<{ vocab: App }>(transport).vocab.words.get({ stem })`. The app's
name is written once, as the key of the type, because `import type` leaves no
name at run time. One client can carry several apps. A view inside the app's
folder has `epicenter:app`; how a program elsewhere names an app's type is left
to the first such program. One name has three spellings: `vocab words get` in a
terminal, `vocab_words_get` over MCP, `epicenter.vocab.words.get` in a typed
client.

**A program with the folder writes files and commits them.** Whispering's
folder is `~/Epicenter/whispering`, created at the first recording after a sheet
that names it, unless the person picks another, which `~/Epicenter/whispering`
then links to (ADR-0858). Whispering owns its `epicenter.json`, writing it
from a template when absent and rewriting its collections when its format
changes while keeping collections it does not own (ADR-0857), and its
`.gitattributes`; it ignores files it does not know. After a recording
it writes its note and audio, the audio named `<id>.local.<ext>` when the person
keeps it on that computer (ADR-0858), and, once the folder is a Git repository,
commits those paths. On a Mac other than your server it pulls from and pushes
to your server over SSH when it can (ADR-0851, ADR-0864). It uses the installed
`git`, because libgit2 does not run Git LFS's filters, and it never needs
`epicenter`. Every program that asks lists, reads, and edits its recordings on
your server without Whispering knowing. A person or agent may add an
`epicenter.ts` to the folder with actions, and add collections of their own to
`epicenter.json` (ADR-0857). Recording, the shortcut, and pasting need the
device and are never actions.

## Consequences

- An app with collections can be browsed and edited from any program with no
  code beyond its declaration. Hand-written actions are left for questions,
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
  them yet; each returns with the first app that does.
- **`list`, `show`, `save`, `delete`.** `show` reads as printing in code, and
  `save` was a word of Epicenter's own where `Map` and Deno KV already agree on
  `get` and `set`.
- **`set` and `delete` marked not destructive because Git keeps every
  version.** True only through `epicenter serve`; a run from the command line
  commits nothing.
- **A written action named like a collection's is a problem.** Leaves the
  generic action callable beside the rule the written one enforces.
- **A client typed by `typeof` the module `epicenter.ts`.** The module's exports
  are only the written actions; the collections' four would be missing.
- **Collection actions spread by hand (`...collection('words')`).** The same
  rule typed in every app, and a second way to pass the declaration.
- **A view's client with the transport passed in: `postMessage` through a host
  that shows the view, MCP over HTTP, or stdio.** A view is a page at
  `/<app>/` on the server's own origin (ADR-0864), so one transport, `fetch` to
  `/`, is all it needs.
