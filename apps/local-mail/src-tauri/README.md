# local-mail desktop shell

The smallest native wrapper around the Bun mail engine (`local-mail app`). It
owns the window and the child engine's lifetime, and nothing else. Gmail OAuth,
token refresh, the reconciler that is Gmail's only writer, the SQLite mirror, the
durable `intent.db`, and the loopback API bearer all stay in Bun end to end
(ADR-0116, ADR-0199). Rust never sees a Gmail token or the bearer.

## How it works

1. `setup()` spawns `bun src/bin.ts app` from the engine package dir.
2. The engine prints the loopback origin it serves (`http://127.0.0.1:<port>`)
   to stdout, once, only after it is listening. That single line is both the
   discovery signal (which port) and the readiness signal (it is up).
3. The shell opens a `WebviewUrl::External` window at that origin. The engine's
   own response headers (frame-deny, `no-store`, CSP) are the security boundary;
   Tauri does not inject CSP into external pages, and the webview never calls
   `invoke()`, so the shell registers no commands and needs no remote-IPC
   allowlist.
4. Closing the window quits the app, which kills the engine (`RunEvent::Exit`).
   The engine never outlives the window: no background mail service (ADR-0116).

This is the ADR-0084 sidecar recipe (spawn the engine, read the port from
stdout, point a window at it), the pattern that spec named for the Tauri wrap.

## Run it (dev)

Prerequisites: `bun` on PATH, and the UI built once so the engine has something
to serve:

```sh
bun run --cwd apps/local-mail/ui build
```

Then, from `apps/local-mail`:

```sh
bun run app:desktop      # == tauri dev: cargo runs the shell, which spawns the engine
```

A connected account is required (`bun run src/bin.ts connect` once). The shell
opens no window until the engine reports its origin, so a blank moment at launch
is the engine starting, not a hang. Watch the terminal for `[sync ...]` and the
`listening on http://127.0.0.1:...` hint.

Only `bun` is called: no port is pinned, so this never collides with a separate
`local-mail app` you already have open. That instance keeps the per-account
reconciler lock, so it is the only one delivering to Gmail; this one serves reads
and can still record triage assertions, which the lock holder delivers on its
next wake (ADR-0199). Both run under their own ephemeral origins.

## Build a desktop bundle

Set the public Google Desktop client identity that belongs to the distribution,
then build:

```sh
LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID=... \
LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET=... \
  bun run desktop:build
```

`beforeBuildCommand` runs `bun run build:desktop` first, which builds the SPA
(`ui/dist`) and compiles the engine sidecar
(`src-tauri/binaries/local-mail-engine-<target-triple>`, a `bun build --compile`
binary, ~60MB). Tauri then bundles both into
`src-tauri/target/release/bundle/macos/Local Mail.app`.

Cargo compiles that pair into the native shell. At launch, the shell passes it
to the Bun engine as public application configuration; OAuth, tokens, mail, and
the SQLite mirror still never transit Rust. An inherited
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` pair remains the machine-wide override
and wins atomically. A source build without a compiled distribution identity
must provide that override.

How the packaged app differs from `tauri dev`:

- **The engine is a compiled sidecar, not `bun src/bin.ts`.** A packaged app has
  no repo beside it and `bun` may be absent from the user's PATH (ADR-0116 keeps
  the whole mail engine in Bun, so it ships as one binary). `bundle.externalBin`
  registers `binaries/local-mail-engine`; Tauri strips the target-triple suffix
  and copies it into `Contents/MacOS/local-mail-engine`. `engine_command` branches
  on `cfg!(debug_assertions)`: dev spawns `bun src/bin.ts app`; release resolves
  `current_exe().parent()/local-mail-engine`.
- **The SPA is a bundled resource, not a source sibling.** A `bun build --compile`
  binary's `import.meta.dir` is a virtual path with no `ui/dist` beside it, so
  the SPA ships via `bundle.resources` (`../ui/dist` -> `Contents/Resources/ui-dist`)
  and the shell passes `LOCAL_MAIL_UI_DIST` (resolved from `resource_dir()`) when
  it spawns the sidecar. The engine's serving code is identical to dev; only the
  root path differs. Same `app` entrypoint, same loopback contract.

Rust still owns only the window and the child's lifetime. The sidecar is the
same Bun engine; no Gmail token, sync, mirror, or bearer transits Rust
(ADR-0116).

## Signing and notarization (the one deferred item)

The produced `.app` is **unsigned** (ad-hoc). That is fine for a locally built
app run on the same machine: it is not quarantined, so Gatekeeper does not block
it. It is not distributable as-is; a downloaded copy would be quarantined and
refused without a right-click-open.

To sign and notarize, no code changes are needed, only credentials and config:

1. An Apple Developer ID Application certificate in the login keychain.
2. `bundle.macOS.signingIdentity` set (or the `APPLE_SIGNING_IDENTITY` env var),
   plus `bundle.macOS.hardenedRuntime: true` and an entitlements file if any
   hardened-runtime exceptions are needed.
3. Notarization credentials (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) so
   `tauri build` can staple the notarization ticket.

Blocker, not a design gap: this machine has no Apple Developer credentials
configured, so the wave ships an unsigned local bundle and leaves the signing
config to whoever holds the certificate. Crib `apps/honeycrisp` for the
hardened-runtime block.

## Deferred niceties (not correctness gates)

- **Graceful engine shutdown.** Exit kills the engine with SIGKILL, which is
  safe by design (the reconciler lock is a kernel-released fcntl lock; presence
  is stale-safe). A SIGINT/SIGTERM path (so the engine clears its presence file
  and releases the lock cleanly) is a nice-to-have. Undelivered work is not at
  risk either way: an assertion is committed to `intent.db` when the act returns,
  and a kill between a Gmail call and its retirement leaves the row, so the next
  pass redelivers it and Gmail no-ops the repeat (ADR-0198, ADR-0199).
- **Orphan on hard kill.** If the app is SIGKILLed, the engine is reparented and
  keeps running (holding the reconciler lock). Harmless and self-healing (the
  lock is crash-safe; the next launch or a manual `kill` clears it), but worth a
  parent-death watchdog if it ever bites.
