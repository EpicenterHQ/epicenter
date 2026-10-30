# SQLite deletion across interruptions

This frozen, fictional-data experiment tests native file-family deletion and
one browser adapter. Its historical `device.sqlite.open(path)` and
`device.sqlite.delete(path)` facades are not package exports or APIs to preserve.
[ADR-0678](../../../../docs/adr/0678-app-storage-openers-use-runtime-bound-scopes.md)
instead defines `openDeviceDatabase(name)` and `deleteDeviceDatabase(name)`
within separate standalone and hosted installation roots. There is no generic
device-file API or parent device handle in that contract. Both ADRs are Accepted
as a design; production adapters remain unbuilt. Preserving this evidence adds
no implementation or compatibility path.

## Evidence and provenance

The [coordinator rerun](results/run-2026-10-22T07-43-38.528Z.json) passed 33
named native cases and 30 each in Chromium, Firefox, and Playwright WebKit.
The [acceptance record](ACCEPTANCE.json) also records passing strict TypeScript
and Rust formatting checks. Both JSON files are copied unchanged. Their absolute
scratch paths identify the original run, not locations required for replay.

The experiment used rusqlite 0.40.2 with SQLite 3.53.2, official
`@sqlite.org/sqlite-wasm` 3.54.1-build1 with SQLite 3.54.1, Bun 1.4.3, and
Playwright 1.61.1 on macOS. Browser versions were Chromium 149.0.7827.55,
Firefox 151.0, and Playwright WebKit 26.5. Playwright WebKit is not validation
of the shipping Safari app or iOS. No Beeper connection, credentials, provider
data, or real browser profile participates.

The [source archive](prototype-source.tar.gz) preserves 11 original files,
including the runner, facades, worker, Rust host, historical README, and Bun and
Cargo dependency locks. File contents are unchanged. Build output, installed
dependencies, browser profiles, fixture databases, and unrelated baseline
prototypes are excluded. Sources stay archived so experimental code does not
become an active part of the Folder package.

## What passed

- Interrupt before main removal and after each exact removal of `p`,
  `p-journal`, `p-wal`, and `p-shm`. Native tests send SIGKILL to their own host;
  browser tests terminate the deletion worker. A fresh process or page checks
  surviving files, refuses creation beside orphaned companions, retries cleanup,
  and creates an empty replacement after cleanup.
- Interrupt a cleanup retry, fail a remaining companion removal twice, and
  eventually finish cleanup. Repeating deletion of an absent family succeeds.
- Inject inspection and removal failures at every family member. Main failure
  stops before companions; companion failure still attempts later members.
  Inspection errors never count as absence.
- Preserve empty and nonempty directories without recursion, neighboring bytes,
  and suffix lookalikes such as `p-wal.backup`. Delete a corrupt unopened native
  main file without checking its header.
- Refuse deletion while a tracked connection opens, remains live, or closes;
  refuse opens and another deletion while deletion is admitted. Retain one
  connection per handle, share repeated close/disposal cleanup, and roll back an
  entire batch on a constraint failure.
- Separately remove actual SQLite-created native WAL and rollback-journal
  remnants after SIGKILL. The all-companion boundary fixtures are synthetic;
  they do not establish stale-WAL replay behavior.
- Reopen each browser's orderly closed persistent profile, read committed
  fictional rows, and delete the database. A database worker terminated without
  close acknowledgment leaves the path Busy until page retirement.

## Reconciliation with the named database contract

The native ordering, orphan guard, and retry results support the mechanism in
[ADR-0673](../../../../docs/adr/0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md).
The prototype accepts flat filenames under fixed fictional roots. It does not
test the logical-name regex, `name` to `name.sqlite` mapping, missing-binding
refusal, separate production/development or hosted/standalone roots, or admission
keyed by installation and name. Two hosted apps opening `state` must not falsely
block each other; deleting hosted `state` must leave standalone `state` intact.
An independently admitted `state-wal` database must also survive deletion of
`state`.

Browser deletion specifically uses literal files on the official `opfs` VFS,
ordinary OPFS inspection/removal, and COOP/COEP isolation headers. Its synthetic
companion-file cleanup does not validate a pooled VFS or `opfs-wl`. Browser
storage layout and interrupted-deletion behavior require checks against the
backend selected for the named opener. Private raw-file fixture helpers establish
observations; they do not require a public `device.files` capability.

Tracking covers one native host process or one browser tab. Other clients remain
the caller's quiescence responsibility. Unexpected browser worker termination
conservatively retains admission until page retirement; `Worker.terminate()` is
not treated as acknowledgment of physical resource release. The separate
[SQL coordination experiment](../device-opfs-coordination/NOTES.md) was not
combined with this deletion protocol.

The native host tests the Rust core, not Tauri IPC, window/document retirement,
or installed-app updates. Browser interruptions stop a worker at acknowledged
filesystem boundaries; profile restart is orderly. Whole-browser crashes,
power loss, interruption inside a pending unlink, cross-process/tab maintenance
exclusion, secure erasure, and provider-side deletion are unverified. The SQL
harness checks basic lifetime and rollback, not full value/authorizer parity.
An app that needs deletion intent to survive interruption before the first
removal must persist that intent separately.

## Replay the frozen experiment

The archive retains its historical API and macOS fixture restrictions. Extract
outside the repository; its `experiments/sqlite-delete/` prefix satisfies the
native host's scratch-root check. On a macOS installation with Bun, matching
Playwright support, and Cargo at `/opt/homebrew/bin/cargo`, prepare dependencies:

```sh
sqlite_delete_scratch="$(mktemp -d)"
cd "$sqlite_delete_scratch"
tar -xzf EVIDENCE_ARCHIVE
cd experiments/sqlite-delete
(cd baseline-browser && bun install --frozen-lockfile)
ln -s ../baseline-browser/node_modules browser/node_modules
/opt/homebrew/bin/cargo fetch --locked --manifest-path native/Cargo.toml
bun baseline-browser/node_modules/playwright/cli.js install chromium firefox webkit
```

Replace `EVIDENCE_ARCHIVE` with the absolute path to `prototype-source.tar.gz`.
The runner requires the dependency symlink and hardcoded Cargo location; neither
is a production requirement. After preparation, run the full matrix:

```sh
bun run run.ts
```

Use `--native-only` or `--browser-only` for a subset. The runner builds native
code offline, binds only loopback, creates fresh browser profiles, and writes
timestamped results beneath the extracted directory. It removes its browser
profiles and leaves fictional native files for inspection. Replay generates new
evidence; it does not rewrite the accepted JSON stored here.
