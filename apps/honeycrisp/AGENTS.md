# Honeycrisp App

Local-first notes SPA. Folders and notes are rows in one Yjs document, and each
note's body is the node on its note row inside that same document
(ADR-0295, ADR-0309). The one application running on the store today, so it is also the
reference for how an app is built.

## One App across Local and Personal

The `[collection=notes]` page captures one Account and owns one App across `/local`
and `/personal`. Its mounted AppBoot captures and opens the App; module imports, route
preloading, sign-in, and callbacks acquire no primary App. Personal is the
default destination; Local also works signed out.

Pass the actual App or its nested data handle intact. Notes receives
`app.device` or `app.account.personal` and adapts its tables through `fromData`.
Use direct props and explicit domain functions, not a second application
controller or context. There is no saved selection or replacement App on view
navigation.

The browser build fixes its authentication service. The desktop build accepts
the Account supplied by the host. Drain editors before closing the App and
changing authentication. Retirement suppresses a pending auth action; failed
cleanup retains ownership until teardown. Unmounting during opening must close
the eventual App. See [the ownership decision](../../docs/adr/0411-honeycrisp-displays-data-from-one-app.md).

## Two builds, one store shape

| Build | Command |
|---|---|
| Web | `bun run build` |
| Epicenter-hosted | `bun run build:epicenter` |

**They differ in nothing that concerns data.** Every build opens the same
client-owned store through the same handle and owns it; the desktop host serves
the bundle and brokers the credential and owns none of it (ADR-0226).
There used to be a platform seam where the hosted build reached the host's
shared `epicenter.sqlite3`, and ADR-0226 refused it.

The `#platform/auth` seam supplies authentication, not data storage. `src/lib/platform-selection.test.ts` reads the
declarations and names a broken seam. `typecheck` runs both conditions;
only the default one is checked by an editor.

## Don'ts

- Keep lifetime verbs at the application boundary. `Notes` consumes the
  ready data; it does not open or close an App.
- Deliberate account/server changes must await departure before auth mutation and
  full navigation. A reactive auth subscriber may close a retired App, but
  must never open a replacement or reload on recoverable credential refusal.
- Do not render a store error to a person as the message. `routes/[collection=notes]/+page.svelte`
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
- Do not put the generation back in the URL or the view navigation. Nobody
  chose that number and no link carries it. When importing a replica ships, an
  import ends in a document reload and a device holding an older number is told
  a newer one exists (ADR-0281); neither is a route parameter.
- Do not add a `#platform/*` seam for data. Every build opens its own store the
  same way, so a seam over the data is the
  thing ADR-0226 refused.
- Do not compose the handle inside a platform leaf. The seam holds the binding
  and nothing built from it, so the application's one App is opened
  once rather than once per build (ADR-0339).
- Do not write a note's `title` or `updatedAt` from anywhere but
	  `openContent`'s subscription. The store writes no derived fields and no
	  timestamps (ADR-0297), so those are Honeycrisp's, hung on the content node's
	  own edit signal and coalesced. A second writer would fight it.
- Do not leave `openContent`'s `close` uncalled. Nothing is loaded any more, so
  there is no document to leak; what leaks is the derivation subscription, and
  two of them on one note write the row twice per keystroke.
