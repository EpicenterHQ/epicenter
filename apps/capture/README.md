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

Capture also runs as its own desktop app (below), over a folder it keeps its
captures in. A folder of captures on a computer, the desktop app's or a clone
of the person's repository (`epicenter clone`), is synced by Epicenter
(`epicenter sync`), never by Capture.

## What it does

Capture opens without an account and has two views (decision 76), each
over its own files:

- **On this device** (`/`): the captures in this browser's private files
  (OPFS), at the same paths a folder holds. It works signed out and
  offline.
- **Synced** (`/synced`, signed in): the person's own repository,
  `<handle>/capture`, through Epicenter. Signed out it asks for a sign-in.

Each view adds, edits, deletes and repairs its own captures. **Add** (or
Ctrl or ⌘ + Enter) writes a finished capture to the view's own files and
opens it at Add a thought; on this device it never waits on the server.
Signed in, the uploader moves every capture on this device into the
repository in the background, once it has gone a few seconds without a
change: it leaves "On this device" and appears in "Synced", whenever it was
made. Nothing keeps it on screen across the move; a capture open on this
device when it uploads says it is now under Synced. The two views are not
merged; one merged list may come back later.

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- The page opens offline once it has been loaded, through its service worker.

Signing out leaves the browser with only the captures it never uploaded.

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
shown body has saved), and Delete capture. Deletion asks first. A capture
on this device has no history; one in "Synced" stays in the repository's
Git history.

The timeline lists captures newest first by the instant captured (a
`capturedAt` with an offset sorts by when it was), then files at a capture's
path that open as text to repair (front matter that does not parse or fit,
or an ambiguous Thoughts layout), then files that are not text.

## Sign-in

The app signs in as `so.epicenter.capture` for the server's Git audience
only (`src/lib/auth.ts`, made on first use). The server is
`VITE_EPICENTER_SERVER` at build time, else Epicenter's. The hosted API does
not serve web writes yet, so signing in works against a local or self-hosted
API.

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

## The desktop app

```sh
bun dev:capture:desktop     # from the repository root; needs a Rust toolchain
bun build:capture:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell (`src-tauri/`, on the shared
[`epicenter-standalone`](../../packages/tauri-epicenter-standalone/README.md)
crate) gives the window two roots (decision 82): Capture's configuration
directory, whose `settings.md` (`appConfig`, machine-local, never synced)
records `folder`, and that folder, where the captures are. On first run there
is no folder, and the page asks "Where should Capture keep its files?"
(`ChooseFolder.svelte`): the Epicenter folder `~/Epicenter/Capture`
(recommended; `~/Epicenter Dev/Capture` for `dev:desktop`), the app data
folder, or "Choose folder…". The shell refuses an unsafe answer in one line,
creates the folder or reuses it with its files, and reopens the window there;
the page then records it with `rememberFolder`.

The page is the same UI as the web, built as the desktop variant
(`bun run build:native`, into `build-desktop/`): the "On this device" view
over the folder (`openDevice(capture, { path: folder })`), with no "Synced"
view, no sign-in (Capture makes no inference calls), and no service worker.
Its header says whether Epicenter syncs the folder, offers **Sync with
Epicenter** until it does (`syncWithEpicenter({ path, contract })`, the
contract at `APPS.CAPTURE.url`'s `contract.json`), and holds **Choose
folder…** in the status details. Closing the window or quitting waits for
saves (the leave guard), and so does Choose folder….

The variant is chosen at build time through `#platform/*` seams, as
[the shared pattern](../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant)
describes: `desktopVariant()` in `vite.config.ts`, `tsconfig.tauri.json`, and
`src/lib/platform.test.ts`, which names a seam whose desktop leaf went
missing.

| Seam | Browser leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/device` | `device.ts`: OPFS | `device.tauri.ts`: the window's folder, or none before the first choice |
| `#platform/folder` | `folder.ts`: none | `folder.tauri.ts`: settings, sync state, Sync with Epicenter, choosing the folder |
| `#platform/auth` | `auth.ts`: sign-in with Epicenter | `auth.tauri.ts`: none |
| `#platform/offline` | `offline.ts`: the service worker | `offline.tauri.ts`: nothing |

## How it is wired

```text
lib/device.ts                openDevice(capture), the page's device
routes/+layout.svelte        the leave guard; signed in, every page under
  SignedIn.svelte            {#key account}: setRepo(openRemote(capture, { account })),
                             startUploading
routes/+page.svelte          "On this device": CaptureApp over fromClient(device).captures
routes/synced/+layout.svelte signed out: asks for a sign-in
  synced/+page.svelte        "Synced": CaptureApp over fromClient(getRepo<Capture>()).captures
    CaptureApp.svelte        header (views, status, sign-in), then
      Timeline | CaptureDetail | TextDetail
```

Views read and write only through the store they are given
(`createCaptures`, in `src/lib/captures.svelte.ts`), over the one client's
captures their page passes, never a client of their own; the timeline shows
them newest first.

| Path | Role |
| --- | --- |
| `src/lib/device.ts` | The device. |
| `src/routes/+layout.svelte` | Every page, the sign-in callback included: the chrome only. |
| `src/routes/(app)/+layout.svelte` | The leave guard; signed in, the signed-in boundary around both views. |
| `src/lib/components/SignedIn.svelte` | The repository (`setRepo`) and the uploader, per account. |
| `src/routes/(app)/+page.svelte` | "On this device", over the device's captures. |
| `src/routes/(app)/synced/` | "Synced", over the repository's captures, behind a layout that asks for a sign-in. |
| `src/lib/components/CaptureApp.svelte` | One view: the header and the page it shows. |
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
| `bun run --cwd apps/capture test` | The contract's fit, the store over real device clients, the mounted views, and both builds' seams. |
| `cargo test -p capture -p epicenter-standalone` | The desktop shell: its capability, the first-run folder choice, moving the folder, guarded Quit. |
| `bun x playwright test -c apps/capture/playwright.config.ts` | End to end in Chromium and WebKit (below). |

The end-to-end suite (`e2e/capture.spec.ts`, on the shared stack in
`packages/cli/src/app-stack.test-support.ts`) runs, per engine: add, give
thoughts, edit and delete captures on this device signed out, while
"Synced" asks for a sign-in; sign in, and they upload, leaving "On this
device" and the browser's files and appearing in "Synced", as does one added
on this device signed in, while one added in "Synced" and a thought added
there go to the repository; `epicenter clone` holds the files byte for byte
and `epicenter check` passes; a desktop thought shows in "Synced" without a
reload and a thought added there reaches the desktop; a broken note written
on the desktop is repaired in "Synced"; sign-out leaves the browser empty
and "Synced" asks for a sign-in again; and, in Chromium, the page opens with
no network and a capture added then is kept in the browser. It needs port
5179 free.
