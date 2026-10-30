# Recorder demo

A small recorder over the file contract. A recording lands in the browser
first (OPFS, marked "not uploaded yet"), uploads to the signed-in person's
repository on its own, and is then an ordinary note plus audio file that a
desktop clone syncs with `epicenter sync`.

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
2. Press **Record**, then **Stop**. The recording shows "not uploaded yet"
   until you sign in.
3. Press **Sign in**. The recording uploads and the mark clears.
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

## Tests

```sh
bun run --cwd apps/recorder-demo test         # unit tests: format, list merge, save and rename
bun run --cwd apps/recorder-demo typecheck
bun x playwright test -c apps/recorder-demo/playwright.config.ts                    # both engines
bun x playwright test -c apps/recorder-demo/playwright.config.ts --project=webkit   # one
```

The Playwright suite (`e2e/demo.spec.ts`) starts the same environment as
`demo` (`e2e/stack.ts`) and walks one person through five steps per engine:
record signed out; sign in and upload, with the first reply lost so the
browser must keep its files until a receipt arrives; clone and
`git lfs pull` on the desktop, comparing the audio's sha256 and running
`epicenter check`; a desktop title edit shown on the web; and a web rename
racing a desktop edit of other fields, both kept. Chromium records from its
fake capture device and WebKit from the tone; both use persistent profiles,
the only kind in which WebKit opens OPFS.
