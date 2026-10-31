# Recorder demo

A small recorder over the file contract. It has two views (decision 76),
each over its own files:

- **On this device**: recording, and the recordings in this browser's
  private files (OPFS), signed out or in, online or not. A recording is kept
  here first, its audio and note as one capture (`saveCapture`).
- **Synced** (signed in): the person's repository, `<handle>/recorder-demo`,
  where each recording is an ordinary note plus audio file that a desktop
  clone syncs with `epicenter sync`. Signed out it asks for a sign-in.

Each view renames, plays and deletes its own recordings. Signed in, the
uploader moves every recording on this device into the repository in the
background: it leaves "On this device" and appears in "Synced". Nothing
keeps it on screen across the move. The two views are not merged; one
merged list may come back later.

The browser keeps the audio it uploaded as a read-only cache, so "Synced"
plays a recording made here without downloading it; signing out drops the
cache.

The contract is `src/contract.ts`: a note per recording at
`recordings/{id}.md` (`title`, `recordedAt`, `durationMs`) and its audio at
`recordings/{id}.{ext}`. It is published as `public/contract.json`, the URL
`epicenter check` takes; `bun run contract` rewrites it after a change.

The app signs in as `so.epicenter.recorder-demo`, a client only a local API
registers (`LOCAL_APPS` in `@epicenter/constants/apps`), and it must be served
on its registered origin, `http://localhost:5214`. The hosted API does not
serve web writes yet, so the demo runs against the local Bun API.

## Run the demo by hand

One command boots everything: a disposable Postgres, the local API with
temporary Git and LFS stores, the built app on port 5214, a demo person, and
a desktop sandbox for the `epicenter` CLI. It needs `initdb`, `pg_ctl`, `git`
and `git-lfs` on `PATH`, and port 5214 free.

```sh
bun run --cwd apps/recorder-demo demo
```

It prints what to open:

1. Open the **Sign in** helper URL it prints. The local API has no working
   sign-in provider, so this page sets the demo person's session on it, then
   opens the app.
2. Press **Record**, then **Stop**. The recording shows under "On this
   device" until you sign in.
3. Press **Sign in**. The recording uploads: it leaves "On this device" and
   appears under "Synced", where Play reads the browser's cached copy, with
   no download.
4. In another shell, `source` the printed `desktop.sh`, then run the
   printed `epicenter clone`, `epicenter check`, and `epicenter sync`
   commands. Edit a note's `title:` in the clone, run `epicenter sync`, and
   reload the app to see it.

Ctrl-C stops everything and deletes it.

## Build, preview and develop

```sh
bun run --cwd apps/recorder-demo build     # static files in dist/
bun run --cwd apps/recorder-demo preview   # serves dist/ on http://localhost:5214
bun run --cwd apps/recorder-demo dev       # Vite dev server on http://localhost:5214
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) can serve it, at an origin its API registers. The
server it signs in to is `VITE_EPICENTER_SERVER` at build time, or
`http://localhost:8788` (`apps/api`'s Bun server) when unset. To run your own
API instead of `demo`, follow "Running the server" and "Hosted Git" in `apps/api`'s
README and build or start the app with `VITE_EPICENTER_SERVER` set to it.

`?fixture=tone` records a 440 Hz oscillator instead of the microphone.

`?repository=<owner handle>/recorder-demo` shows a repository another person
shared with the signed-in account (`epicenter share`) under "Synced"; this
browser's own recordings then stay under "On this device" and upload only
when the parameter is gone.

## Code

- `src/App.svelte`: the header and the two views. Signed in, "Synced"
  renders under `src/SignedIn.svelte`, the signed-in boundary: the
  repository (`setRepo`) and the uploader, per account.
- `src/DeviceView.svelte`: "On this device": recording, saved with
  `saveCapture`, and the device's recordings.
- `src/SyncedView.svelte`: "Synced", the recordings of `getRepo()`.
- `src/Library.svelte`, `src/RecordingRow.svelte`: one view's recordings,
  read and edited through that view's client alone.
- `src/lib/recordings.ts`: one client's notes and audio, joined by id.

## Tests

```sh
bun run --cwd apps/recorder-demo test         # unit tests: contract, format, rows
bun run --cwd apps/recorder-demo typecheck
bun x playwright test -c apps/recorder-demo/playwright.config.ts                    # both engines
bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/demo.spec.ts`) starts the same environment as
`demo` (`e2e/stack.ts`) and walks one person through nine steps per engine:
signed out, record on "On this device", rename it, and delete another,
while "Synced" asks for a sign-in; sign in, and it uploads with the first
reply lost, so the browser keeps its files until a reply arrives, then it
leaves "On this device" for "Synced", the browser keeps only the audio as a
cache, and "Synced" plays it with no LFS download; with every request to
the server failing, a new recording is kept on this device, and uploads
once the server is back, then is deleted in "Synced"; clone and
`git lfs pull` on the desktop, comparing the audio's sha256 and running
`epicenter check`; a desktop title edit shown in "Synced"; a rename in
"Synced" over a note the desktop changed meanwhile, which lands beside the
desktop's edit; a rename over a desktop rename, refused as `Conflict`: the
row keeps the draft, and saving again lands it; `epicenter share` with a
second person, whose own signed-in browser shows and plays the recording
under "Synced"; and sign-out, after which the browser holds no files. In
WebKit a tenth step opens an ephemeral context, which refuses OPFS as
Safari's private windows do: a recording the device cannot keep stays in
the page, with "Save again" and "Download it". Chromium records from its
fake capture device and WebKit from the tone; both use persistent
profiles, the only kind in which WebKit opens OPFS. WebKit keeps OPFS
outside the profile directory, so the first step empties the origin's
files before it records.
