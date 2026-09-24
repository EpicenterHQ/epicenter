# Native shared AI catalog acceptance

This fixture runs the desktop catalog through two installed test applications,
real macOS WebViews, the Bun sidecar, and Rust's OS keychain bridge. Each test
application opens a complete Local App with the default `epicenter-host` AI
binding. Their IDs are `so.epicenter.catalog-test-a` and
`so.epicenter.catalog-test-b`; they are acceptance applications, not shipped
Whispering or Vocab builds.

## Run

Use macOS 14 or newer with an unlocked login keychain, Bun 1.3.14 or newer,
the Rust toolchain, Xcode command-line tools, and installed workspace dependencies.
The runner reuses the native Cargo target cache. It needs the compiled host
assets under `apps/epicenter/dist`; build those first when absent or stale.
Run from the repository root:

```sh
bun run --cwd apps/epicenter build
bun packages/app/scripts/shared-ai-catalog.native.mjs
```

The runner prints its temporary evidence directory. `result.json` records the
asserted outcomes, process IDs, credential-free endpoint observations, and
cleanup. The directory also retains built test applications, the copied native
source, native logs, and command results. Command inputs contain fixture keys.
No provider account, microphone, downloaded model, or hosted service is required.

### Whispering product workflow

Add `--whispering` to exercise the built desktop product after the catalog checks:

```sh
bun run --cwd apps/epicenter build:desktop
EPICENTER_NATIVE_AUDIO=/path/to/speech.wav bun packages/app/scripts/shared-ai-catalog.native.mjs --whispering
```

This mode requires an existing speech WAV and the already-cached
`handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf` model. It downloads
nothing. The runner opens Whispering's Local store, adds a connection through
its transcription picker, and observes the shared connection from another App.
It supplies the WAV to the actual Upload File control and checks the transcript
and saved selection after document reload. Automation uses DOM events without
replacing application operations.

The authenticated loopback endpoint forwards to the existing native inference
fixture: real decoding and Whisper Tiny inference through Tauri MockRuntime.
Whispering itself runs in the real macOS WebView and reaches that endpoint
through the production catalog broker and keychain. The report records the
uploaded bytes' digest, model, authentication, transcript, and fixture cleanup.
This mode does not exercise microphone capture or the native file chooser.

## Isolation and observation

Each run creates a fresh profile directory, bundle identifier, keychain service,
loopback port, and WebKit data-store UUID. Restarts retain those identities.
The finalizer removes credentials from the run's unique keychain service,
including after a failed assertion. Profile files and the isolated WebKit store
remain available for diagnosis; the result records the store UUID.

The runner copies the current Rust and Bun host sources into the evidence
directory. Only that copy gains file-driven window automation, a test event
permission, WebKit store selection, and a Bun exit-code report. It also wraps
the HTTP event response to count subscriptions and interrupt SSE. Catalog
commands, secret dispatch, keyring storage, inference forwarding, and
native shutdown use their existing implementations. The runner closes the
host's prewarmed Whispering window before counting the two test subscriptions.

The compatible endpoint runs on loopback; the runner checks the authorization
it receives.
For closure checks it leaves a response body unfinished and observes each
upstream abort. App closure, window destruction, and host shutdown must each
cancel that body. Before destroying one window, the fixture also leaves a native
SQL connection with an uncommitted insert and a temporary table. A new window
opens the same named database and must observe neither. This proves physical SQL
connection teardown and transaction rollback independently of browser admission.
The fixture also reloads that window and repeats the rollback and TEMP-table
assertions. Both native and Bun processes must exit with code zero.

The 2026-09-18 ready-App run passed these assertions. Whole-host shutdown still
logs a late SQLite dispatcher cleanup failure: Rust stops its SQL worker before
Bun requests connection closure after protocol EOF. Window and document teardown
are verified independently. This run does not prove SQL state after whole-host
shutdown; it does not treat the warning as a successful late close.

## Recorded acceptance

The current fixture requires explicit connection creation and leaves legacy
browser settings untouched and unusable. Catalog metadata and product selections
use the no-account namespace. The default fixture passed on 2026-09-18: real
WebViews, keychain access, process restart, SSE reconnect, access retirement, and
three upstream cancellations. The isolated keychain service was empty afterward.
This run used model discovery; the optional Whispering audio mode was not rerun.
The historical run below predates account isolation.

The [2026-09-10 result](20260910-result.json) covers shared snapshots, independent
selections, key omission, key retention/replacement/removal, same-key assignment,
missing-key repair, URL changes, and refusal of stale clients and broker versions.
It also covers a missed revision delivered after SSE reconnect in the same
document, process restart with saved credentials and IDs, and deleted legacy
records staying deleted despite their retained import source.

Native acceptance exposed these failures and now guards their repairs:

- Fetch abort can error its response before App cancellation runs. The App
  distinguishes that stored error from a failing cancellation callback by
  checking `reader.closed`; actual cleanup failures still reject `app.close()`.
- Bun 1.3.14 exits with an unhandled error when a response stream is errored
  during forced socket shutdown. The broker closes an already-disconnected
  request's stream and still cancels upstream. Retiring access for a connected
  caller continues to error its response.
- Reconstructing a multipart request with `new Request(url, request)` turns its
  body into a streaming upload, which WebKit rejects. The desktop transport
  preserves the encoded body and multipart boundary when forwarding audio to
  the broker, and checks retirement before sending it.

The run records CSP observations. ArkType's `envHasCsp` probe attempts dynamic
evaluation, receives a `script-src` rejection, and selects its interpreter.
This is not a claim of zero CSP events. The native host uses a development
build with built SPA assets; this does not establish signed release packaging,
Windows/Linux behavior or native microphone capture. Product UI evidence requires
the optional Whispering mode; the default two-app run alone does not establish it.

The recorded run used macOS 26.5.2 and Bun 1.3.14 with `--whispering`. It ran
from an isolated copy of commit `39e25d49f9` plus this task's changes, with
workspace dependencies resolved inside that copy. Its 167 focused App,
catalog/route/server, and selection/picker tests passed with 931 assertions.
All three browser acceptance harnesses, App typechecks, and both Whispering
builds passed. Root typechecking retained the eight starting Data diagnostics;
documentation hygiene retained its 44 existing issues. No unrelated working
changes were removed or incorporated into these repairs.
