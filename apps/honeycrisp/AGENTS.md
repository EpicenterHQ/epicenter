# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's body is the node on its note row inside that same document
(ADR-0295, ADR-0309). The one application running on the store today, so it is also the
reference for how an app is built.

Design authority: [ADR-0339](../../docs/adr/0339-an-application-creates-one-epicenter-and-an-account-is-what-adds-a-store.md) (an application creates one epicenter, and an account is what adds a store), [ADR-0226](../../docs/adr/0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (a host serves bundles and brokers credentials and owns no application data), [ADR-0225](../../docs/adr/0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md) (one authority per principal and application; being signed in is the sharing model), [ADR-0295](../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (a database is one Yjs document and a row holds its rich content), [ADR-0292](../../docs/adr/0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) (a database opens an exact generation cache-first), [ADR-0336](../../docs/adr/0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (an authority mints every generation, so every store has an account), [ADR-0324](../../docs/adr/0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) (the address is the application, the data id, and the generation), [ADR-0256](../../docs/adr/0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md) (automatic folding is current; manual workspace compaction is deferred).

## One library per application document

`src/lib/application.ts` captures the saved Local, Personal, or Shared library
choice and the raw `authClient` Account, then opens one App. Local works signed
out; Personal and Shared require the captured Account. Shared is available on
a self-hosted server (ADR-0375). The mounted `routes/+page.svelte` dynamically imports it; callback and
preloaded route modules must not acquire data. The same document never opens
a replacement App. `auth.svelte.ts` adapts auth only for UI reads.

The page submits buffered editor work and unmounts consumers before awaiting
`app.close()`. Account/server changes then use full document navigation.
A preflight refusal leaves controls usable; a failure after teardown begins
requires a fresh document. Keep storage identity and Account transport captured
at construction. The shared departure owner sequences closure and navigation;
it does not select or open another library.

`StoreShell` adapts the ready App with `fromData`. `createHoneycrisp` supplies
notes, search, and navigation through `getHoneycrisp()`. Within-library
navigation keeps that concrete App. Whole-library removal remains unavailable.

## The folder is a working copy, and a person fills it

`~/Epicenter/so.epicenter.honeycrisp/` holds these notes as files, and nothing
puts them there by itself (ADR-0337). `PullToFolder.svelte` is the button; the
verb is `pull` from `src/lib/folder.ts`, which is the library's verb with this
application's definition supplied. It needs nothing else, because the store
states its own address and that is what the manifest records (ADR-0340).

A pull shows every edit in the folder it is about to write over and takes one
approval. Confirming the list IS the discard (ADR-0341); there is no second
gesture. It also refuses
where there is no folder at all, which is every ordinary browser tab: a page
has no filesystem, and the copy says so rather than offering a retry.

A pull also writes an `AGENTS.md` at the folder root, generated from the
compiled definition (ADR-0330): the tables, their fields, and which edits come
back. Every pull replaces it, and it says so on its first line, so a person
keeping notes to themselves keeps them under another name.

`SendFolderEdits.svelte` is the other direction: `diff` shows what a push would
do, and `push` applies it and writes back the files it touched. **The folder
wins, and a push is one
approval** (ADR-0338). Nothing is asked per item and nothing is validated on the
way in: a value goes in whatever it says, a body replaces the note's text, a new
file becomes a note, and a deleted file deletes one. To change any of it, cancel,
edit the file, and push again.

The dialog is the overview, ranked by what is still reachable afterwards, and it
renders as one block of plain text so a person can paste it to the agent that
made the mess. Two buttons, and Enter reaches Push all.

A push writes rows this release cannot read, on purpose, from a text editor.
`NoteList.svelte` is where they show up, beside the readable notes rather than
only in the empty state.

Deleting a file deletes the note, for good, without passing through Recently
Deleted. Trashing a note through the folder is the other gesture: set
`deletedAt` in the frontmatter, which is an ordinary value edit. No table
declares a trash field and none should.

A file an agent wrote becomes a note and **is renamed**, because a note's id is
minted rather than chosen. That is in the overview before a person approves it,
and in the `AGENTS.md` a pull writes, so an agent knows to re-read the folder
after a push.

One thing is not a plan at all: a folder nothing ever wrote. `diff` reports it
as a state rather than failing, `push` refuses it, and `pull` writes over it
after showing the paths once for the folder rather than once per file.

## Three builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build opens the same
client-owned store through the same handle and owns it; the desktop host serves
the bundle and brokers the credential and owns none of it (ADR-0226).
There used to be a platform seam where the hosted build reached the host's
shared `epicenter.sqlite3`, and ADR-0226 refused it.

What remains behind `#platform/*` is auth and the folder only: how a build gets a
bearer, not where its data lives. `src/lib/platform-selection.test.ts` reads the
declarations and names a broken seam. `typecheck` runs both conditions;
only the default one is checked by an editor.

## Don'ts

- Keep lifetime verbs at the application boundary. `StoreShell` consumes the
  ready App; it does not select or replace a library.
- Deliberate library changes must await departure before auth mutation and
  full navigation. A reactive auth subscriber may close a retired App, but
  must never open a replacement or reload on recoverable credential refusal.
- Do not render a store error to a person as the message. `routes/+page.svelte`
  passes `appName` and `noun` to `@epicenter/app-shell/boot-screens` and writes
  no sentence itself; `openFailure` decides which failure earns one. A failure
  earns its own only by changing what a person can DO: `AlreadyOpen`, because
  they can close the other window, and `LocksUnsupported`, because a retry
  button there would be a lie. Everything else shares one sentence and one Try
  again.
- Do not write a Honeycrisp-shaped screen here when the shape is every
  application's. The two words that are this application's are its name and
  `notes`; a new arm belongs in `open-failure.ts`, where all three applications
  get it at once.
- Do not put `workspace`, `replica`, `authority`, `document`, or `sync cursor`
  in anything a person reads. They are the right words in this file and in
  `packages/app/src/data`, and the wrong ones in a tooltip.
- Do not detect the host at runtime. The build already answered.
- Do not migrate, import, or delete data belonging to another build. The web
  build and the hosted build are two stores on one machine, and nothing moves
  between them. Two devices converge by signing into the same account, not by
  copying a file.
- Do not add a boot screen for a distinction a person cannot act on. A
  generation that is missing and one that is unreachable both mean "try again
  when the world has changed", so they share a sentence; splitting them wrote
  two screens whose only difference was the word "downloaded".
- Do not put the generation back in the URL or the library picker. Nobody
  chose that number and no link carries it. When importing a replica ships, an
  import ends in a document reload and a device holding an older number is told
  a newer one exists (ADR-0281); neither is a route parameter.
- Do not add a `#platform/*` seam for data. Every build opens its own store the
  same way, so a seam over the data is the
  thing ADR-0226 refused.
- Do not compose the handle inside a platform leaf. The seam holds the binding
  and nothing built from it, so the application's one `epicenter` is defined
  once rather than once per build (ADR-0339).
- Do not write a note's `title` or `updatedAt` from anywhere but
	  `notes.openContent`'s subscription. The store writes no derived fields and no
	  timestamps (ADR-0297), so those are Honeycrisp's, hung on the content node's
	  own edit signal and coalesced. A second writer would fight it.
- Do not leave `openContent`'s `close` uncalled. Nothing is loaded any more, so
  there is no document to leak; what leaks is the derivation subscription, and
  two of them on one note write the row twice per keystroke.
