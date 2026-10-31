# Capture

Capture is for capturing and glancing: write or paste something, keep it as a
dated capture, add thoughts to it later, and see everything newest first.
Each capture is a Markdown note at `captures/<id>.md`: `capturedAt` in front
matter, then its text and its thoughts as a bullet list under
`## Thoughts`. That layout is Capture's contract, `capture` in
[`packages/capture`](../../packages/capture/README.md), published unchanged
as `static/contract.json` (`bun run contract` rewrites it after a change), the
file `epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

Capture is a web app only; it has no desktop app of its own. A folder of
captures on a computer is a clone of the person's repository, kept with
`epicenter clone` and `epicenter sync`.

## What it does

Capture in a browser is its online variant only: the person's own
repository, `<handle>/capture`, through Epicenter, at `/`. Signed out it
asks for a sign-in; signed in, every add, edit and delete is a commit
there, and nothing is kept in the browser. It needs the network; there is
no browser copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

**Add** (or Ctrl or ⌘ + Enter) writes a finished capture to the repository
and opens it at Add a thought. The header says where the captures are and
whether the repository answers: Online, Offline when it does not, or Sign in
again when the session needs renewing; Sign out is beside it.

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.

## A capture

Open a capture to edit its text and add, reorder, copy, or delete thoughts.
New capture and Add a thought are explicit submissions: their text boxes
write nothing before Add, and leaving clears them. The capture text and the
thought commands compose over one body edit (`fieldEdit` over the body), so
a thought command never loses text typed just before it. Typed text shows
until its save answers; a save that fails stays with Save again, Discard and
Copy. Thoughts are identified by their position in the shown list; a move or
delete refuses a list that changed beneath it.

**Edit as text** shows the whole note, front matter included: a capture
that reads, in house style (`noteText`); a file that does not, as it is. What
is typed is a draft, checked as it is typed (`readNoteText`, then the
Thoughts layout). **Save** replaces the whole note (`replace`) over the
version the draft began from: text whose front matter does not parse or fit
is refused with why, and a change made elsewhere since is refused rather than
overwritten, with Save again (replace theirs) or Use the saved text. A saved
note whose Thoughts read opens as a capture. A thought's Edit as text first
saves the shown body, then selects that thought's lines.

**More** holds Copy capture text, Download file (the note's text once the
shown body has saved), and Delete capture. Deletion asks first; a deleted
capture stays in the repository's Git history.

The timeline lists captures newest first by the instant captured (a
`capturedAt` with an offset sorts by when it was), then files at a capture's
path that open as text to repair (front matter that does not parse or fit,
or an ambiguous Thoughts layout), then files that are not text.

## Sign-in

Capture signs in as `so.epicenter.capture` for the server's Git audience
only (`src/lib/auth.ts`, made on first use). The server is
`VITE_EPICENTER_SERVER` at build time, else Epicenter's. The hosted API
does not serve web writes yet, so signing in works against a local or
self-hosted API.

## Run it

From the repository root:

```sh
bun dev:capture                         # Vite dev server on http://localhost:5179
bun run --cwd apps/capture build        # static files in apps/capture/build/
bun run --cwd apps/capture demo         # the whole stack, to try it by hand
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`demo` boots a disposable Postgres, the local API with temporary Git and LFS
stores, the built app on `http://localhost:5179`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's
`capture` repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on
`PATH`, and port 5179 free. Ctrl-C deletes everything.

## How it is wired

```text
routes/+layout.svelte          every page: the chrome and the leave guard
routes/(app)/+layout.svelte    the root that decides the store, the signed-in layout:
                               signed out, a sign-in; signed in,
  Online.svelte                {#key account}: setRepo(openRemote(capture, { account }))
routes/(app)/+page.svelte      CaptureApp over fromClient(getRepo<Capture>()).captures
  CaptureApp.svelte            header (where, status, account), then
    Timeline | CaptureDetail | TextDetail
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Components read and write only through the captures they are given
(`createCaptures`, in `src/lib/captures.svelte.ts`), never a client of their
own; only the `(app)` layout chooses the store. Another variant needs only
a new root that passes `CaptureApp` its own store's captures.

| Path | Role |
| --- | --- |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome and the leave guard. |
| `src/routes/(app)/+layout.svelte` | The signed-in layout: asks for a sign-in, or opens the repository per account. |
| `src/lib/components/Online.svelte` | The repository (`setRepo`), per account. |
| `src/routes/(app)/+page.svelte` | Capture over the repository's captures. |
| `src/lib/components/CaptureApp.svelte` | The header and the page it shows, over the captures it is given. |
| `src/lib/captures.svelte.ts` | The timeline, Add, deletion, and navigation. |
| `src/lib/capture-actions.svelte.ts` | Thought and text commands over one body edit; a thought's lines in the note's text. |
| `src/lib/components/CaptureDetail.svelte` | A capture as its text and thoughts. |
| `src/lib/components/TextDetail.svelte` | A capture's note as text, saved with `replace`. |
| `src/lib/components/Timeline.svelte` | New capture, captures, files to repair. |

## Checks

| Command | What it checks |
| --- | --- |
| `bun test packages/capture` | The contract and the body codec. |
| `bun run --cwd apps/capture typecheck` | App, scripts, and end-to-end types. |
| `bun run --cwd apps/capture test` | The contract's fit, and the store and mounted components over a stand-in client (a folder client in a temporary directory). |
| `bun x playwright test -c apps/capture/playwright.config.ts` | End to end in Chromium and WebKit (below). |

The end-to-end suite (`e2e/capture.spec.ts`, on the shared stack in
`packages/cli/src/app-stack.test-support.ts`) walks one person through five
steps per engine: Capture asks for a sign-in, and signed in shows an empty
repository where captures are added, given thoughts, edited, downloaded and
deleted, never in the browser's files, and survive a reload; `epicenter
clone` holds them byte for byte and `epicenter check` passes; a desktop
thought shows without a reload and a thought added in the browser reaches
the desktop; a broken note written on the desktop is repaired; and signing
out asks for a sign-in again. It needs port 5179 free.
