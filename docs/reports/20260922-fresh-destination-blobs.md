# Fresh destination blob copies: implementation and review

## Files inspected

Paths are relative to the workspace root. This is the task-owned file inventory,
including deleted files inspected at the task-start baseline. Related caller,
lifecycle, configuration, and skill files appear in the reviewer inventories
below. The checkout also contains concurrent work on native inference; those
changes are outside this task. Shared README/index files retain that work.

```text
.
|-- apps
|   |-- api
|   |   `-- scripts
|   |       `-- smoke.ts
|   |-- epicenter
|   |   `-- src
|   |       |-- account-transport.test.ts
|   |       `-- server.ts
|   `-- whispering
|       `-- src
|           |-- lib
|           |   |-- components
|           |   |   `-- AudioBlobPlayer.svelte
|           |   |-- data.ts
|           |   |-- operations
|           |   |   |-- recording.svelte.test.ts
|           |   |   |-- upload-recording.test.ts
|           |   |   `-- upload-recording.ts
|           |   |-- queries
|           |   |   `-- audio.ts
|           |   |-- services
|           |   |   `-- README.md
|           |   `-- whispering
|           |       |-- recordings-markdown-export.test.ts
|           |       |-- recordings.test.ts
|           |       |-- recordings.ts
|           |       `-- resources.ts
|           `-- routes
|               `-- (app)
|                   `-- (config)
|                       `-- recordings
|                           `-- actions
|                               `-- UploadRecordingButton.svelte
|-- docs
|   `-- adr
|       |-- 0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md
|       |-- 0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md
|       |-- 0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md
|       |-- 0092-identity-is-the-partition.md
|       |-- 0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md
|       |-- 0154-blob-access-is-address-only.md
|       |-- 0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md
|       |-- 0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md
|       |-- 0349-local-blobs-belong-to-the-app-on-this-device.md
|       |-- 0366-a-recorder-captures-into-its-explicit-local-blob-destination.md
|       |-- 0372-local-and-remote-blobs-open-independently.md
|       |-- 0393-rows-refer-to-blobs-without-owning-their-lifetime.md
|       |-- 0404-the-opened-account-owns-application-local-storage.md
|       |-- 0426-blob-identities-survive-copies-between-scoped-locations.md
|       |-- 0426-copies-create-independent-blobs-at-their-destination.md
|       |-- 0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md
|       `-- README.md
`-- packages
    |-- app
    |   |-- README.md
    |   `-- src
    |       |-- blob-copy.test.ts
    |       |-- blob-owner.ts
    |       |-- independent-blobs.test.ts
    |       `-- product-startup.test.ts
    |-- blobs
    |   |-- README.md
    |   `-- src
    |       |-- app-remote.test.ts
    |       |-- blob-remote.ts
    |       |-- browser.ts
    |       |-- bun.test.ts
    |       |-- bun.ts
    |       |-- equal-bytes.test.ts
    |       |-- equal-bytes.ts
    |       |-- index.ts
    |       `-- owner.ts
    |-- client
    |   `-- src
    |       |-- blob-format.test.ts
    |       |-- index.test.ts
    |       `-- index.ts
    `-- server
        `-- src
            |-- routes
            |   |-- blobs.test.ts
            |   `-- blobs.ts
            `-- s3-blob-store.ts
```

Independent review inventories, before findings:

```text
Files read (whole files or explicitly inspected excerpts; search-only hits are listed separately)
.
|-- .agents/skills/
|   |-- adversarial-review/SKILL.md
|   |-- adversarial-review/references/deletion-prizes.md
|   |-- post-implementation-review/SKILL.md
|   `-- greenfield-clean-breaks/SKILL.md
|-- tsconfig.base.json
|-- tsconfig.dom.json
|-- packages/
|   |-- app/
|   |   |-- README.md
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- src/
|   |       |-- blob-owner.ts
|   |       |-- blob-destination.ts
|   |       |-- blob-copy.test.ts
|   |       |-- blob-retirement.test.ts
|   |       |-- blobs.test-d.ts
|   |       |-- independent-blobs.test.ts
|   |       |-- product-startup.test.ts
|   |       `-- recorder.ts
|   |-- blobs/
|   |   |-- README.md
|   |   `-- src/
|   |       |-- owner.ts
|   |       |-- blob-remote.ts
|   |       |-- blob-store.ts
|   |       |-- browser.ts
|   |       |-- bun.ts
|   |       |-- bun.test.ts
|   |       |-- app-remote.test.ts
|   |       `-- index.ts
|   |-- client/src/
|   |   |-- index.ts
|   |   `-- index.test.ts
|   `-- server/src/
|       |-- s3-blob-store.ts
|       `-- routes/
|           |-- blobs.ts
|           `-- blobs.test.ts
|-- apps/
|   |-- epicenter/src/
|   |   |-- server.ts
|   |   `-- account-transport.test.ts
|   `-- whispering/src/
|       |-- lib/
|       |   |-- data.ts
|       |   |-- components/AudioBlobPlayer.svelte
|       |   |-- operations/upload-recording.ts
|       |   |-- operations/upload-recording.test.ts
|       |   |-- queries/audio.ts
|       |   `-- whispering/
|       |       |-- app.ts
|       |       |-- resources.ts
|       |       |-- recordings.ts
|       |       `-- recordings.test.ts
|       `-- routes/(app)/
|           |-- +layout.svelte
|           `-- (config)/recordings/actions/UploadRecordingButton.svelte
`-- docs/adr/
    |-- 0372-local-and-remote-blobs-open-independently.md
    |-- 0415-runtime-replacement-ends-application-sessions.md
    |-- 0423-stores-own-data-and-blobs-while-services-open-independently.md
    |-- 0426-copies-create-independent-blobs-at-their-destination.md
    `-- 0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md

/tmp/
|-- fresh-copy-changed.txt
|-- fresh-copy-all-types.log
|-- fresh-copy-native.log
`-- epicenter-fresh-copy-baseline-20260922/
    |-- packages/app/src/blob-owner.ts
    |-- packages/blobs/src/bun.ts
    `-- apps/whispering/src/
        |-- lib/whispering/resources.ts
        |-- lib/whispering/recordings.ts
        `-- routes/(app)/(config)/recordings/actions/UploadRecordingButton.svelte

Additional files inspected only through symbol-search excerpts
packages/
|-- client/src/blob-format.test.ts
|-- blobs/src/app.test.ts
|-- blobs/scripts/browser-smoke-entry.ts
|-- blobs/scripts/browser-smoke.ts
`-- app/evidence/private-media/page.ts
apps/whispering/src/lib/
|-- operations/pipeline.test.ts
`-- boot-node.test.ts
```

```text
Files read (paths relative to /Users/braden/conductor/workspaces/epicenter/yamoussoukro unless prefixed):
.
|-- .agents/skills/
|   |-- adversarial-review/SKILL.md
|   |-- post-implementation-review/SKILL.md
|   `-- greenfield-clean-breaks/SKILL.md
|-- packages/
|   |-- app/
|   |   |-- README.md
|   |   |-- tsconfig.json
|   |   `-- src/
|   |       |-- blob-owner.ts
|   |       |-- blob-destination.ts
|   |       |-- blob-copy.test.ts
|   |       |-- independent-blobs.test.ts
|   |       `-- product-startup.test.ts
|   |-- blobs/
|   |   |-- README.md
|   |   `-- src/
|   |       |-- owner.ts
|   |       |-- blob-remote.ts
|   |       |-- blob-store.ts
|   |       |-- browser.ts
|   |       |-- bun.ts
|   |       |-- webview.ts
|   |       |-- app-remote.test.ts (targeted search)
|   |       `-- bun.test.ts (targeted search)
|   |-- client/
|   |   |-- package.json
|   |   `-- src/
|   |       |-- index.ts
|   |       |-- index.test.ts (targeted portions)
|   |       `-- blob-format.test.ts (targeted search)
|   `-- server/src/
|       |-- routes/blobs.ts
|       `-- s3-blob-store.ts
|-- apps/
|   |-- epicenter/src/
|   |   |-- server.ts (copy, relay, local publication paths)
|   |   `-- account-transport.test.ts (copy and lifetime portions)
|   `-- whispering/src/
|       |-- lib/
|       |   |-- data.ts
|       |   |-- boot-node.test.ts
|       |   |-- components/AudioBlobPlayer.svelte
|       |   |-- queries/audio.ts
|       |   |-- operations/
|       |   |   |-- upload-recording.ts
|       |   |   `-- upload-recording.test.ts
|       |   `-- whispering/
|       |       |-- app.ts
|       |       |-- resources.ts
|       |       |-- recordings.ts
|       |       `-- ui-session.ts
|       `-- routes/(app)/(config)/recordings/actions/UploadRecordingButton.svelte
|-- docs/adr/
|   |-- 0372-local-and-remote-blobs-open-independently.md
|   |-- 0415-runtime-replacement-ends-application-sessions.md (root lifetime portion)
|   |-- 0423-app-resources-open-as-independent-handles.md
|   |-- 0426-copies-create-independent-blobs-at-their-destination.md
|   `-- 0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md
`-- node_modules/.bun/wellcrafted@0.44.0/node_modules/wellcrafted/dist/
    |-- error-BkeqDeUq.js (search excerpt)
    |-- error-BkeqDeUq.js.map (embedded source excerpt)
    `-- error/index.d.ts
/tmp/
|-- fresh-copy-changed.txt
`-- epicenter-fresh-copy-baseline-20260922/
    |-- packages/app/src/blob-owner.ts (diff)
    |-- packages/client/src/index.ts (diff)
    |-- apps/epicenter/src/server.ts (diff)
    `-- apps/whispering/src/
        |-- lib/whispering/resources.ts
        `-- routes/(app)/(config)/recordings/actions/UploadRecordingButton.svelte

Additional discovery used rg across the affected package/app trees to locate copy aliases, stale same-ID language, lifecycle callers, and test names. Incidental search matches outside the above reconstruction were not inspected as implementation evidence.
```

## Result

`destination.blobs.copyFrom(source.blobs, sourceId, { signal })` returns a fresh
destination BlobId after exact-byte publication. Each call is independent.
Repeated calls may create duplicate objects. Personal accepts Local sources;
Local accepts Local or Personal. Direct `personal.blobs.add(file)` follows the
same destination-allocation rule.

```text
Local[sourceId] -- copyFrom --> Personal[newRemoteId]
                                    |
                                 copyFrom
                                    v
                              Local[newLocalId]

Whispering row
  audioBlobId -> original Local object
  remoteAudio -> { blobId, namespace, authorityId, principalId }
```

The authenticated remote collection POST allocates the ID on the server and
returns `201 { id }`. Public object routes cannot publish at a caller-selected
ID. Conditional S3 creation and atomic local publication still refuse occupied
keys. Native transfers carry source and destination IDs separately and preserve
descriptor snapshots without routing the payload through the WebView.

Whispering borrows `local.blobs` and `personal.blobs`, saves the returned remote
reference, and checks its scope before reading or suppressing a new upload.
A failed row write retains the published reference in the error. Root stores
retain their existing browser/WebView lifetime; departure retires the recorder.

## Adversarial review and accepted repairs

Two fresh read-only GPT-6 reviewers independently reconstructed the implementation
against `/tmp/epicenter-fresh-copy-baseline-20260922`, rather than HEAD. Both
supported fresh destination IDs. Both completed a focused follow-up and found
the accepted repairs resolved.

1. Delete completed-object equality verification, occupied-identical success,
   and same-ID remote reconciliation. Preserve conditional publication. The
   cost is duplicate storage after a repeated call or lost acknowledgment.
2. Remove the newly introduced Whispering aggregate root cleanup. Existing page
   replacement owns those roots, so mutable Personal state, aggregate close,
   rollback, and late-root cleanup added no required guarantee. Keep recorder
   retirement, operation cancellation, and explicit SDK store close semantics.
3. Preserve definite native destination collisions as `BlobAlreadyExists`.
   A terminal 409 must permit both stores to close; lost or malformed receipts
   remain uncertain and retain exclusion when cleanup cannot be established.
4. Preserve Local add's minted ID and destination in its public error type.
   The actual add error union is storage failure or occupied key; it does not
   invent read failures merely to share a larger error union.
5. Use the same scope predicate for reads and upload-button state. A Local row
   uploaded under another account cannot disable an explicit new upload into
   the current account. The old account's bytes are not deleted.
6. Require a native receipt to confirm its assigned destination ID. A valid but
   different returned ID is not proof of the requested publication.

The final reread retained the ownership layers that enforce admission, source
provenance, dual-store cancellation/drain, and presentation disposal. The
Personal add forwarding method became a direct property. Pending recorder and
Bun staging receipts remain because they retry one admitted publication; they
are not completed-object equality machinery. The Bun directory setup remains
necessary because the adapter permits a not-yet-created storage directory.

Current and resulting organization:

```text
Before                                After
packages/blobs/src/                   packages/blobs/src/
|-- equal-bytes.ts                     |-- bun.ts (strict publication + receipts)
|-- equal-bytes.test.ts                `-- owner.ts (operation lifetime)
|-- bun.ts
`-- owner.ts

docs/adr/                             docs/adr/
`-- 0426-blob-identities-              `-- 0426-copies-create-independent-
    survive-copies-between-               blobs-at-their-destination.md
    scoped-locations.md
```

Other boundaries stay in place. Replacing native copies with `get` plus `add`
would reduce code but force complete files through the WebView. Removing
transfer tracking would permit releasing ownership while host work remained
uncertain. Neither tradeoff is accepted.

## Verification

Commands run with the installed Bun and package working directories:

| Check | Result |
| --- | --- |
| App `bun test --isolate src` | 690 passed |
| Blobs `bun test --isolate src` | 96 passed |
| Client `bun test --isolate src` | 31 passed |
| Server blob-route tests | 13 passed |
| Desktop account/transport tests | 21 passed |
| Whispering upload, recording storage, Markdown export tests | 17 passed |
| App, blobs, client, server, desktop host typechecks | Passed |
| Whispering browser and host typechecks | Passed |
| Task-owned `git diff --check` | Passed |

The 868 passing tests cover fresh IDs, exact bytes, repeated publication,
source deletion, unsupported sources, bounded uploads, account scope, native
receipts and descriptor lifetimes, definite collision cleanup, store retirement,
and published-reference recovery after a row failure.

The broader `recording.svelte.test.ts` has 15 passing and five failing native
recorder workflow cases. The same five failures reproduce against the saved
task-start source. They concern lost Start replies, uncertain Start/Cancel, and
Stop recovery; this change does not alter the recorder implementation. A changed
failure fixture now includes the actual scoped add error and its assertion passes.
Root-level multi-package execution also exposed Bun module-resolution problems;
package-local execution resolves those and exposes the actual test outcomes.

Biome checked the touched TypeScript files with no errors after repairs. Existing
style warnings, chiefly non-null assertions in tests, remain. No provider-backed
S3 smoke, physical microphone test, or browser playback run was performed for
this identity-contract change. No deployment or commit was made.

## Remaining transfer work

Remote uploads still use the existing buffered 25 MiB limit. This implementation
does not claim large-video, multipart, persistent reservation, or restart-resume
support. The next transfer change can use bounded multipart attempts behind the
same `add`/`copyFrom` API, retaining a private upload ID within an attempt while
returning one fresh destination BlobId on success. No manifest or physical-key
indirection is needed for the chosen copy contract.

Product playback-worker registration remains deferred from the previous scoped
blob implementation. The copy and scoped-reference migration does not establish
an end-to-end browser playback release.
