# Capture

Capture is for capturing and glancing: write or paste something, keep it as a
dated capture, add thoughts to it later, and see everything newest first.
Each capture is a Markdown note at `captures/<id>.md`: `capturedAt` in front
matter, then its text and its thoughts as a bullet list under
`## Thoughts`. That layout is Capture's contract, `capture` in
[`src/lib/model`](src/lib/model/README.md), published unchanged
as `static/contract.json` (`bun run contract` rewrites it after a change), the
file `epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

Capture has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the signed-in person's
repository, and a desktop app over a folder of captures it keeps on the
computer (below). A folder of captures on a computer, the desktop app's or a
clone of the person's repository (`epicenter clone`), is synced by Epicenter
(`epicenter sync`), never by Capture.

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
thought commands compose over one editor of the note
(`folder.captures.edit({ id })`), so
a thought command never loses text typed just before it. Typed text shows
until its save lands. A save never fails: while the store cannot be
reached, the folder keeps it, in order, and sends it when it can, and the
page says so (`<WhenOpen>`). Thoughts are identified by their position in
the shown list; a move or delete refuses a list that changed beneath it.

**Edit as text** shows the file's whole text, front matter included, as it
is, through the same kind of editor over the note's whole text
(`folder.captures.edit({ id }).text`). Typing saves it, in house style
where its front matter parses: text whose front matter does not parse or
fit is written, and the capture is listed to repair until it does. Whether
it reads is checked as it is typed (`readNoteText`, then the Thoughts
layout). A change made elsewhere since the typing began is settled with
it, as sync settles it, so neither is lost. **Open as capture** opens it
once what was typed has landed and its Thoughts read. A thought's Edit as
text first waits for the shown body to land, then selects that thought's
lines.

**More** holds Copy capture text, Download file (the note's file once the
shown body has landed), and Delete capture. Deletion asks first, then
closes the capture; a deleted capture stays in the repository's Git
history.

The timeline lists captures newest first by the instant captured (a
`capturedAt` with an offset sorts by when it was), then files at a capture's
path that open as text to repair (front matter that does not parse or fit,
or an ambiguous Thoughts layout), then files that are not text.

## Sign-in

Capture signs in as `so.epicenter.capture` for the server's Git audience
only (`connectAccount()` in `src/lib/account.ts`, made once in
`src/lib/app.ts`, and only by the web build). The server is
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
src/lib/app.ts                 the page's values, each read through reactive:
                               account (#platform/account) and
                               folder = reactive(openFolder(capture, home({ site, account })));
                               editing it, or what it imports, reloads the page
routes/+layout.svelte          every page: the chrome
routes/(app)/+layout.svelte    signed out on the web: SignIn; otherwise
                               <WhenOpen app="Capture" {folder}> (spinner, Recovery,
                               pages, and the leave guard while folder.saving())
routes/(app)/+page.svelte      CaptureApp
  CaptureApp.svelte            createCaptures(folder.captures); header (Chrome from
                               #platform/chrome), then
    Timeline | CaptureDetail | TextDetail
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Every component imports what it reads from `$lib/app.js`
(`folder.captures`), never a client of its own; only `app.ts` opens the
store
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
The page state over the captures (`createCaptures`, in
`src/lib/captures.svelte.ts`) is given them by `CaptureApp` and passed to
each view. On the web the folder is the account's copy: it opens once the
account is signed in, and a new account is a new page (sign-in returns
through `/auth/callback`, which reloads).

| Path | Role |
| --- | --- |
| `src/lib/app.ts` | The account and the folder, opened once for the page. |
| `src/lib/account.ts`, `account.tauri.ts` | The web build's sign-in; none on the desktop. |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome. |
| `src/routes/(app)/+layout.svelte` | `SignIn` while the web build is signed out; otherwise `<WhenOpen>` over the folder. |
| `src/lib/components/SignIn.svelte`, `OnlineChrome.svelte` | The web app's signed-out page; the header's status and account. |
| `src/lib/components/DesktopChrome.svelte` | The header's local history status, Set up in Epicenter, and the folder's path (`folder.displayPath`). |
| `src/lib/components/CaptureApp.svelte` | The header and the page it shows, over `folder.captures`. |
| `src/lib/captures.svelte.ts` | The timeline, Add, deletion, and navigation. |
| `src/lib/capture-actions.svelte.ts` | Thought and text commands over one body edit; a thought's lines in the note's text. |
| `src/lib/components/CaptureDetail.svelte` | A capture as its text and thoughts. |
| `src/lib/components/TextDetail.svelte` | A capture's note as text, saved with `replace`. |
| `src/lib/components/Timeline.svelte` | New capture, captures, files to repair. |

## The desktop app

```sh
bun dev:capture:desktop     # from the repository root; needs a Rust toolchain
bun build:capture:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives the data folder from the app's site and names it
the Data root, which the page opens by name. The page opens `~/Epicenter/capture` (`~/Epicenter Dev/capture`
in development), making it when missing for now. A failed open shows the
shared recovery screen with Retry. The files remain when the app is removed.

The page is the same UI as the web, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), over the folder
(`openFolder(capture, home({ site, account }))`, whose desktop `home` is the
Data root)
with no sign-in: Capture makes no
inference calls, and Epicenter can keep the folder's local history. Its header
says whether Epicenter manages the folder, offers **Set up in Epicenter** until it does
(`syncWithEpicenter({ contract })`, the contract at `APPS.CAPTURE.url`'s
`contract.json`), and shows the shell's folder path in the status details.
Closing the window or quitting does not wait.

The build picks the folder: `home` from `@epicenter/folder` resolves
to its desktop leaf under the `tauri` condition that `desktopVariant()` in
`vite.config.ts` turns on, and to the web leaf otherwise. Three things are
Capture's own and differ by build, through `#platform/*` seams
([the shared pattern](../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant));
`tsconfig.tauri.json` typechecks the desktop leaves, and
`src/lib/platform.test.ts` names a seam or capability whose desktop leaf
went missing.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/account` | `account.ts`: `connectAccount()`, the browser sign-in | `account.tauri.ts`: none, `null` |
| `#platform/chrome` | `OnlineChrome.svelte`: the repository's status and the account | `DesktopChrome.svelte`: the folder's local history status and Set up in Epicenter |
| `#platform/variant` | `variant.ts`: `'online'` | `variant.tauri.ts`: `'desktop'`, for the few sentences that name the store |

## Checks

| Command | What it checks |
| --- | --- |
| `bun test apps/capture/src/lib/model` | The contract and the body codec. |
| `bun run --cwd apps/capture typecheck` | App, scripts, and end-to-end types. |
| `bun run --cwd apps/capture test` | The contract's fit, the page state over a folder at a place in memory (`memory()`), whose writes can be made to wait, the mounted views over the app's memory folder, and both builds' seams. |
| `cargo test -p capture -p epicenter-standalone` | The desktop shell: its capability, the derived data folder and opening refusals. |
| `bun x playwright test -c apps/capture/playwright.config.ts` | End to end in Chromium and WebKit (below). |

`bun run test` passes `--conditions=test`, so `$lib/app.js` opens a folder
in memory and a signed-out account, and the mounted views read that folder
and mock no module. What happens outside the folder goes through
`memoryFiles(folder)` from `@epicenter/folder/memory`: another program
writing a file (one that does not read, too), and the folder's own writes
made to wait.

The end-to-end suite (`e2e/capture.spec.ts`, on the shared stack in
`packages/cli/src/app-stack.test-support.ts`) walks one person through five
steps per engine: Capture asks for a sign-in, and signed in shows an empty
repository where captures are added, given thoughts, edited, downloaded and
deleted, never in the browser's files, and survive a reload; `epicenter
clone` holds them byte for byte and `epicenter check` passes; a desktop
thought shows without a reload and a thought added in the browser reaches
the desktop; a broken note written on the desktop is repaired; and signing
out asks for a sign-in again. It needs port 5179 free.
