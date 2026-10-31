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

Capture opens without an account. Signed out, captures live in this
browser's private files (OPFS), at the same paths a folder holds. Signing in
with Epicenter opens the person's own repository, `<handle>/capture`, beside
them as one list:

- **Add** (or Ctrl or ⌘ + Enter) writes a finished capture to this browser
  at once, signed in or not, and opens it at Add a thought. It never waits on
  the server and works offline. Signed in, the capture uploads behind it and
  the browser then lets go of its copy; until then it is marked "Not
  uploaded yet". Captures made signed out upload the same way once someone
  signs in.
- Edits and deletes go to the copy shown: the browser's while it holds one,
  else the repository's, which is online only. An edit made while a capture
  uploads follows it, and an open capture stays open while it moves.
- Signed in with the server unreachable, the header says "Offline: new
  captures wait to upload", and new captures and their thoughts do.
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
still in this browser has no history; one in the repository stays in its Git
history.

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

## How it is wired

```text
routes/+page.svelte          openDevice(capture) at the root (setDevice), and
                             the one list over it, signed out
  SignedIn.svelte            {#key account}: openRemote(capture, { account }),
                             the one list over both, startUploading
    CaptureApp.svelte        header (where, status, sign-in), then
      Timeline | CaptureDetail | TextDetail
```

Views read and write only through the store they are given
(`createCaptures` over `createCaptureList`, in `src/lib/captures.svelte.ts`),
never a client. The list is `oneList` from `@epicenter/svelte/client` with
`createOn: 'device'` and newest-first order.

| Path | Role |
| --- | --- |
| `src/routes/+page.svelte` | The device and the signed-out list. |
| `src/lib/components/SignedIn.svelte` | The repository, the two-sided list, and the uploader. |
| `src/lib/captures.svelte.ts` | The one list, the timeline, Add, deletion, and navigation. |
| `src/lib/capture-actions.svelte.ts` | Thought and text commands over one body edit; a thought's lines in the note's text. |
| `src/lib/components/CaptureDetail.svelte` | A capture as its text and thoughts. |
| `src/lib/components/TextDetail.svelte` | A capture's note as text, saved with `replace`. |
| `src/lib/components/Timeline.svelte` | New capture, captures, files to repair. |

## Checks

| Command | What it checks |
| --- | --- |
| `bun test packages/capture` | The contract and the body codec. |
| `bun run --cwd apps/capture typecheck` | App, scripts, and end-to-end types. |
| `bun run --cwd apps/capture test` | The contract's fit, the store over real device clients, and the mounted views. |
| `bun x playwright test -c apps/capture/playwright.config.ts` | End to end in Chromium and WebKit (below). |

The end-to-end suite (`e2e/capture.spec.ts`, on the shared stack in
`packages/cli/src/app-stack.test-support.ts`) runs, per engine: add, give
thoughts, edit and delete captures signed out; sign in and upload; add
offline and upload once back; `epicenter clone` holds the files byte for byte
and `epicenter check` passes; a desktop thought shows on the web without a
reload and a web thought reaches the desktop; a broken note written on the
desktop is repaired on the web; sign-out leaves the browser empty; and, in
Chromium, the page opens with no network and a capture waits in the browser.
It needs port 5179 free.
