# Recorder demo

A small recorder over the file contract, in two variants. Each page is one
variant with one store for its whole life, and nothing ever moves from one
to the other ([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):

- **On this browser** (`/`, the local variant): the recordings in this
  browser's private files (OPFS, `openDevice`), for good. It needs no
  account and offers no sign-in, works offline, and never uploads. A
  recording is two writes through the device client: its audio, then its
  note.
- **Online** (`/online`, the online variant): the person's repository,
  `<handle>/recorder-demo`, through Epicenter (`openRemote`), behind a
  sign-in. A recording goes straight into it, its audio (a Git LFS object)
  and then its note, and plays from it; nothing is kept in the browser, and
  without the server it can do nothing. Signed out it asks for a sign-in.

The header links the two as ways to use the recorder; each link loads a new
page. Both play, rename and delete their own recordings. A recording the
store does not take (a private window has no file storage; an unreachable
server refuses) stays in the page with **Save again** and **Download it**.

The contract is `src/contract.ts`: a note per recording at
`recordings/{id}.md` (`title`, `recordedAt`, `durationMs`) and its audio at
`recordings/{id}.{ext}`. It is published as `public/contract.json`, the URL
`epicenter check` takes; `bun run contract` rewrites it after a change.

The online variant signs in as `so.epicenter.recorder-demo`, for the
server's Git audience only, a client only a local API registers
(`LOCAL_APPS` in `@epicenter/constants/apps`), and it must be served on its
registered origin, `http://localhost:5214`. The demo has no hosted
capability, so the local variant never signs in. The hosted API does not
serve web writes yet, so the online variant runs against the local Bun API.

## Run the demo by hand

One command boots everything: a disposable Postgres, the local API with
temporary Git and LFS stores, the built app on port 5214, a demo person, and
a desktop sandbox for the `epicenter` CLI. It needs `initdb`, `pg_ctl`, `git`
and `git-lfs` on `PATH`, and port 5214 free.

```sh
bun run --cwd apps/recorder-demo demo
```

It prints what to open:

1. On **On this browser** (`/`), press **Record**, then **Stop**. The
   recording is kept in this browser, with no account.
2. Open the **Sign in** helper URL it prints. The local API has no working
   sign-in provider, so this page sets the demo person's session on it, then
   opens the app.
3. Follow **Online** and press **Sign in**. The repository starts empty:
   the recording on this browser stays there. Record here, and it goes
   straight into the repository.
4. In another shell, `source` the printed `desktop.sh`, then run the
   printed `epicenter clone`, `epicenter check`, and `epicenter sync`
   commands. Edit a note's `title:` in the clone and run `epicenter sync`;
   the online page shows it without a reload.

Ctrl-C stops everything and deletes it.

## Build, preview and develop

```sh
bun run --cwd apps/recorder-demo build     # static files in dist/
bun run --cwd apps/recorder-demo preview   # serves dist/ on http://localhost:5214
bun run --cwd apps/recorder-demo dev       # Vite dev server on http://localhost:5214
```

The build is static: any host that answers unknown paths with `index.html`
(for `/online` and `/auth/callback`) can serve it, at an origin its API registers. The
server it signs in to is `VITE_EPICENTER_SERVER` at build time, or
`http://localhost:8788` (`apps/api`'s Bun server) when unset. To run your own
API instead of `demo`, follow "Running the server" and "Hosted Git" in `apps/api`'s
README and build or start the app with `VITE_EPICENTER_SERVER` set to it.

`?fixture=tone` records a 440 Hz oscillator instead of the microphone.

`/online?repository=<owner handle>/recorder-demo` opens a repository another
person shared with the signed-in account (`epicenter share`) instead of the
account's own.

## Code

- `src/main.ts`: picks the page's root by path and loads only it; for the
  local variant it first awaits this browser's files (`openDevice`).
- `src/LocalApp.svelte`: the local variant's root, over the device
  `main.ts` opened for the page.
- `src/OnlineApp.svelte`: the online variant's root: sign-in, and, signed
  in, `src/SignedIn.svelte` per account, which opens the repository
  (`openRemote`) and hands it to the recorder.
- `src/Recorder.svelte`, `src/Library.svelte`, `src/RecordingRow.svelte`:
  recording, the list and one row, each over the client the recorder is
  given and that client alone. The recorder wraps it once for Svelte
  (`fromClient`) and hands both down: a row reads audio bytes through the
  client and shows and edits through the wrapped one.
- `src/lib/recordings.ts`: one client's notes and audio, joined by id.

## Tests

```sh
bun run --cwd apps/recorder-demo test         # unit tests: contract, format, rows
bun run --cwd apps/recorder-demo typecheck
bun x playwright test -c apps/recorder-demo/playwright.config.ts                    # both engines
bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/demo.spec.ts`) starts the same environment as
`demo` (`e2e/stack.ts`) and walks one person through the two variants per
engine. On this browser, with no sign-in offered and no request to the
server: a recording lands in OPFS as its audio and its note, plays, is
renamed, another is deleted, and all of it survives a reload; offline
(`goOffline`), recording and renaming still work. Online: it asks for a
sign-in; signed in, the repository holds none of this browser's recordings,
and one recorded and renamed there lands in it, plays from it and never
reaches OPFS; `epicenter clone` holds the note and a Git LFS pointer to the
bytes the page played, which `git lfs pull` brings down, and
`epicenter check` passes; a desktop title edit shows with no reload; a
rename over a desktop rename is refused as `Conflict`, keeps its draft, and
lands on a second save; `epicenter share` with a second person, whose own
signed-in browser shows and plays the recording. Back on this browser,
signing in and out moved nothing. In WebKit a last step opens an ephemeral
context, which refuses OPFS as Safari's private windows do: a recording
the browser cannot keep stays in the page, with "Save again" and
"Download it". Chromium records from its fake capture device and WebKit
from the tone; both use persistent profiles, the only kind in which WebKit
opens OPFS. WebKit keeps OPFS outside the profile directory, so the first
step empties the origin's files before it records.
