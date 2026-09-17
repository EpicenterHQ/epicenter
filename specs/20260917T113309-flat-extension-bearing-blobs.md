# Flat extension-bearing blobs

**Date**: 2026-09-17
**Status**: Draft
**Owner**: Braden Wong

## One sentence

An app saves immutable bytes under extension-bearing keys, uses those keys as
desktop filenames and browser database keys, and keeps recording details in
its rows.

This is the implementation plan for the direction in
[local blob storage](../docs/adr/0349-local-blobs-belong-to-the-app-on-this-device.md),
[saved recording](../docs/adr/0366-recording-is-an-app-scoped-portable-capability.md),
[explicit hosting](../docs/adr/0372-an-account-app-exposes-explicit-blob-hosting.md),
and [row references](../docs/adr/0393-rows-refer-to-blobs-without-owning-their-lifetime.md).
No runtime or stored-data changes accompany this plan. Completion means the
flat file and IndexedDB paths pass the same saved-object tests, real recording
and playback work, affected consumers use full keys, and the approved
existing-data disposition has been verified before old code is removed.

The [concurrent native-capture plan](20260912T122859-concurrent-native-capture.md)
still owns device admission. Its finished-file handoff and separate library-save
instructions do not apply: ADR-0366 and this plan govern saved output.

## Current and target shape

The following examples shorten the random part of IDs. Production keys retain
the 21-character random body.

```text
Implemented                                Target

Desktop blobs/                             Desktop blobs/
  blob_abc/                                  blob_abc.wav
    data                                     blob_def.webm
    metadata.json

IndexedDB                                  IndexedDB
  blob-data[id] = {id, bytes}                 objects[id] = {id, bytes, size}
  blob-metadata[id] = {id, size, type}         listing index = [id, size]

Recording row                              Recording row
  audioBlobId = "blob_abc"                    audioBlobId = "blob_abc.wav"
  title, transcript                          title, transcript

Capture -> successful Stop -> saved key -> app.blobs.local.open(key)
```

The implemented metadata field is named `contentType`; `type` in the diagram
abbreviates that field. Target `bytes` is an ArrayBuffer. The browser keeps a
derived length for metadata-only operations, not a second metadata object
store. The layout changes; app scope, independent blob lifetime, explicit
uploads, and the saved-result handoff do not.

Desktop files are directly readable by compatible external tools. This does not
make the internal directory a user-managed folder: renaming or replacing files
outside the app can break references or immutability. No directory watcher or
external-edit synchronization is introduced.

## Evidence and owners

The inspected implementation places the relevant responsibilities here:

```text
packages/blobs/
  README.md
  src/blob-id.ts             key grammar and minting
  src/blob-metadata.ts       type normalization and list validation
  src/blob-store.ts          size/type/list/copy contract
  src/app.ts                 public add mints the local key
  src/browser.ts             version-1 paired IndexedDB stores
  src/bun.ts                 directory-backed desktop objects
  src/webview.ts             host HTTP access and response validation
  src/blob-source.ts         temporary presentation URLs
packages/app/src/
  open.ts                    binds recorder to the app's byte writer
  recorder.ts                Stop result and live capture contract
  recording/browser.ts       final Blob construction and save retries
  recording/desktop.ts       native result validation and event correlation
apps/epicenter/
  src/server.ts              HEAD, ranges, file upload, copy, security headers
  src-tauri/src/blobs.rs     native key grammar and filesystem publication
  src-tauri/src/recorder/    capture identity, finalization, Stop receipts
apps/whispering/src/lib/
  data.ts                    audioBlobId field uses the shared key regex
  operations/import.ts       accepts filename-only format evidence
  operations/pipeline.ts     persists imported File/Blob before creating row
  operations/recording.svelte.ts
                             creates the row after successful Stop
  queries/download.ts        supplies audio to download services
  services/download/         exported names and file extensions
  services/transcription/    provider filenames and format handling
packages/client/src/index.ts
                             validates captured-owner remote URLs
packages/server/src/routes/blobs.ts
                             mints fresh remote IDs and enforces upload size
```

The ID prefix has no role in authorization. App construction selects the local
namespace. The captured Account and server resolve remote ownership. Native
capture commands validate their caller and live capture identity separately
from parsing a saved key.

The source and external specifications establish these constraints:

- Browser storage uses ArrayBuffer because native Blob persistence has failed
  in the project's WebKit checks. Changing the filename does not fix that.
- The browser recorder uses `recorder.mimeType || chunks[0]?.type`; desktop
  capture writes WAV. Do not hardcode `.wav` across platforms.
- Imported File objects can have an empty media type and a supported filename.
  The File reaches `local.add` through a Blob-typed parameter; retain that
  filename information when choosing the extension.
- `list`, `stat`, and `statMany` have body-free read expectations. The browser
  tests prohibit body reads during listing. Computing `byteLength` after
  retrieving an ArrayBuffer does not meet that expectation.
- Native publication retains the outcome after a rename or final sync error.
  File publication must retain that retry behavior, not only the success path.
- [IndexedDB keys](https://www.w3.org/TR/IndexedDB-3/#key-construct) can be
  strings. [Index key cursors](https://w3c.github.io/IndexedDB/#dom-idbindex-openkeycursor)
  expose index keys without exposing the referenced record value. These
  semantics do not establish a browser engine's memory or disk-I/O cost.
- [MediaRecorder media types](https://w3c.github.io/mediacapture-record/#dom-mediarecorder-mimetype)
  describe the output container and encoding. A suffix is not a conversion.

## Decisions and deliberate losses

The durable decisions are in the linked ADRs. The following table separates
their rationale from evidence that implementation still needs to produce:

| Decision | Class | Choice and cost |
| --- | --- | --- |
| Complete key | Design coherence | `blob_<random>.<extension>` is one immutable reference; no ID-to-filename catalog or independent extension field is needed to locate bytes. |
| Prefix and random body | Taste under constraints | Keep `blob_` and 21 lowercase alphanumeric random characters for recognizable keys and existing random-generation behavior. |
| Format policy | Design coherence | Use a supported actual producer media type, then a supported imported suffix when type is absent/generic, otherwise `.bin`. Keep the original human filename out of the storage path. |
| Local MIME | Design coherence | Return one conventional type per supported suffix; exact input MIME/codec parameters do not round-trip through local storage. |
| File length | Design coherence | Desktop uses actual filesystem size. Dropping JSON also drops its expected-length consistency check; it was not a checksum. |
| Browser length index | Evidence | One record plus a derived covering index preserves body-free stat/list. Validate WebKit and Chromium memory behavior before adoption. |
| Publication | Evidence | Complete, immutable file publication requires a tested no-replace primitive and durability sequence; ordinary overwriting rename is insufficient. |
| Existing objects | Unresolved product constraint | Preserve bytes and references; approve a specific disposition before changing active readers, row validators, or deployed URL parsers. |

Keep `blob_` for diagnostic recognition rather than compatibility aliases.
Revisit the prefix only if a different repository-wide ID convention has a
concrete consumer benefit. Do not spend the storage rewrite renaming it.

Do not add an exact-MIME row field preemptively. Ordinary playback, export, and
upload use the key's conventional type. If a named consumer needs the original
parameters, record that requirement and carry the value from capture/import
into a declared row field. Do not silently recreate the deleted blob catalog.

## Consumer translations

These excerpts are from the inspected source. Target snippets are proposals,
not declarations of exports already implemented.

### Local add selects the complete key

Before, `packages/blobs/src/app.ts`:

```ts
const id = generateBlobId();
const result = await local.put(id, blob);
return result.error === null ? Ok(id) : result;
```

Target, after selecting `extension` from the format policy:

```ts
const id = generateBlobId(extension);
const result = await local.put(id, blob);
return result.error === null ? Ok(id) : result;
```

Keep the public `add(blob)` call. Its implementation must recognize File inputs
without relying on cross-runtime `instanceof File` where that constructor is
unavailable. Pin the supported format/extension mapping and filename fallback
in tests; do not add a general MIME-sniffing dependency.

### Stop separates a live capture from its saved key

Before, `packages/app/src/recording/desktop.ts`:

```ts
if (
  !parseBlobId(result.data.blobId) ||
  result.data.blobId !== recording.id
)
  return RecorderError.RecorderFailed({
    cause: 'The host returned an invalid saved blob.',
  });
```

Target, after the native session pins and verifies the saved outcome for the
specific capture:

```ts
if (!parseBlobId(result.data.blobId))
  return RecorderError.RecorderFailed({
    cause: 'The host returned an invalid saved blob.',
  });
```

This is not permission to remove correlation checks in isolation. Preserve
capture ownership, request/response correlation, and the saved-result receipt.
`sessionId` is the document owner and `requestId` identifies a start request;
neither becomes the recording's saved key. The browser pins its full key once
the actual output format is known and reuses it after a failed save. Native
capture can pin `.wav` before acquisition. Only successful Stop establishes
that the returned key names a committed object.

### Recording rows and upload calls keep their shape

Before, `apps/whispering/src/lib/operations/recording.svelte.ts`:

```ts
const saved = await recordings.create({
  audioBlobId: result.data.blobId,
  title: '',
  recordedAt: metadata.recordedAt,
  recordedAtZone: metadata.recordedAtZone,
  transcript: '',
  polishedTranscript: null,
  duration: result.data.durationMs,
});
```

Target: this call is unchanged. `audioBlobId` contains the full key with its
extension; the shared regex in `apps/whispering/src/lib/data.ts` changes only
after the existing-row disposition is approved. The upload workflow continues
to call `app.blobs.remote.addLocal(recording.audioBlobId)` and save the returned
owner-pinned URL. No second local save follows Stop.

## Build, switch, prove, remove

### Establish preservation and format fixtures

- [ ] Re-read the dirty worktree and capture task-owned baseline failures.
  Keep the concurrent App-scope, platform-selection, native-admission, and
  generation work separate from this storage change.
- [ ] Build a non-mutating inventory of app-local extensionless objects,
  browser version-1 stores, row references, hosted URLs, and historical roots.
  Use synthetic fixtures for development; do not inspect or mutate production
  data implicitly.
- [ ] Obtain the existing-data disposition before cutover. Recommend an
  explicitly authorized copy-and-verify conversion where continued access is
  required: create full keys, verify bytes, then update affected references,
  retaining originals through interrupted runs. Account for offline rows and
  independent hosted URLs. This plan does not authorize that conversion.
- [ ] If archival/fresh start is chosen instead, name the rows and URLs that
  become unavailable and obtain approval for that consequence. Leaving files
  on disk alone is not preservation of access.
- [ ] Capture supported native, browser, and imported formats, including empty
  MIME, codec parameters, aliases, unknown formats, and conflicting names. Pick
  one conventional media type for extensions shared by audio/video containers.
  Test format equivalence, including `audio/wav` and `audio/x-wav`, rather than
  treating different MIME strings as necessarily conflicting formats.
  A fresh remote upload can canonicalize an equivalent extension; it does not
  promise the same filename or ID as the local source.

### Build the new adapters against isolated stores

- [ ] Change minting, parsing, route regexes, and cursor validation together.
  Use exactly one dot and a bounded lowercase alphanumeric suffix. Reject
  separators, encoded traversal, query/fragment syntax, trailing dots,
  controls, and arbitrary user filenames. Test TypeScript/Rust agreement.
- [ ] Make full keys immutable. Raw writes cannot claim a known type
  conflicting with the key. Storage `copy` preserves the source suffix;
  conversion belongs to a producer that creates different bytes.
- [ ] Implement one flat desktop file per key. Keep incomplete output in
  reserved same-directory temporary names outside the valid BlobId grammar.
  Names distinguish Bun/native ownership. Neither process sweeps another's
  live work; startup cleanup requires proof that its owner cannot still write.
- [ ] Prove atomic no-replace publication with independent Rust and Bun
  publishers. Preserve finalized bytes and publication receipts across
  retryable errors. Do not use check-then-overwriting-rename or recursive
  deletion for a flat object. File deletion is scoped to one validated key.
- [ ] Reject symbolic links and nonregular final entries. An existing file,
  directory, or dangling link is a collision, not a replacement target. Check
  supported-platform directory and handle behavior before claiming race safety.
- [ ] Add a versioned IndexedDB `objects` store with keyPath `id`, records
  `{id, bytes, size}`, and a `[id, size]` index. Commit bytes and derived size
  together. Use key cursors for list/stat/statMany; derive content type from
  the key. Do not store per-object contentType or recording metadata.
- [ ] Upgrade additively: retain `blob-data` and `blob-metadata` while the
  approved data transition is incomplete. Handle blocked upgrades, older
  connections, and transaction failure. Never migrate with `deleteDatabase()`.
- [ ] Preserve disposable browser URLs and native HTTP streaming. Do not
  introduce a SQLite engine, WebView audio transfer, or shared chunk protocol.

### Switch producers and consumers as one contract change

- [ ] Bind native and browser recorder output to the same scoped store used by
  `app.blobs.local`. Separate live capture controls from saved keys where the
  format is established later; preserve stale-session and lost-response tests.
- [ ] Update imports, row validation, export filenames, transcription filenames,
  local copy, native decoding paths, host HEAD/ranges, and remote upload
  forwarding. Remove the download/transcription default that labels unknown
  bytes as MP3. Export can use a friendly name but must preserve the format.
- [ ] Update fresh remote ID minting and account-pinned URL validation together.
  Keep owner/app authorization, redirect refusal, size enforcement, native
  streaming, and independent remote lifetime. Leave provider Content-Type
  metadata intact. Do not rewrite saved URLs to guess extensions.
- [ ] Keep `attachment`, sandbox CSP, `nosniff`, and same-origin protections on
  desktop byte responses. Filename extension is not executable-content trust.
- [ ] Apply the approved existing-data disposition before switching live
  readers. Stop importing old adapters, but retain their source unused until
  replacement verification passes. Do not ship a silent fallback reader as
  an accidental permanent compatibility mode.

### Prove the complete journeys

Use focused tests before repository-wide checks. The implementation must prove:

- [ ] Native Stop saves a valid WAV that Bun can read after recorder teardown.
  A compatible external player opens the flat `.wav` file. Browser Stop saves
  its actual format and opens the same key after document reload.
- [ ] Save, get, stat, statMany, pagination, copy, deletion, and playback agree
  across adapters. Page/stat reads do not materialize audio buffers. Measure
  representative large-library memory and latency in WebKit and Chromium;
  standards support for key cursors alone is not a performance result.
  Test compound-index bounds for exclusive string cursors and exact-ID stat
  queries, including zero-byte records: index keys are `[id, size]` arrays.
- [ ] Two publishers racing the same full key cannot replace each other.
  Failure before publication exposes no completed object. Failure after
  publication but before acknowledgment cannot erase or duplicate that object.
  Cancel, close, and startup cleanup preserve committed and historical files.
- [ ] Empty-MIME imports keep a supported extension. Known format mappings
  produce playable/exportable files. Unknown content stays `.bin`; changing
  its suffix does not count as conversion. Generic reads return conventional,
  not original parameterized, content types.
- [ ] Failed row creation leaves enumerable bytes. Row deletion and account
  changes do not erase audio. Upload failure does not delete its source.
- [ ] HEAD, byte ranges, download, explicit upload, owner-pinned remote playback,
  and account retirement work with dotted keys. Verify the installed desktop
  path and an authorized real provider; mocks do not close these acceptance gaps.
- [ ] Populated v1 database fixtures survive upgrades, blocked connections, and
  failed conversion. Every approved old reference remains usable or has the
  explicitly approved archival outcome. Historical staging stays untouched.

Existing verification entrypoints include:

```sh
bun test packages/blobs/src
bun test packages/app/src/recording
bun test packages/app/src/blobs.test.ts packages/app/src/blob-retirement.test.ts
bun test apps/epicenter/src/server.test.ts apps/epicenter/src/account-transport.test.ts
bun test packages/client/src/index.test.ts packages/server/src/routes/blobs.test.ts
bun test apps/whispering/src/lib/operations/pipeline.test.ts
bun test apps/whispering/src/lib/operations/recording.svelte.test.ts
bun test apps/whispering/src/lib/operations/upload-recording.test.ts
bun test apps/whispering/src/lib/whispering/recordings.test.ts
bun packages/blobs/scripts/native-smoke.ts
bun run --cwd packages/blobs smoke:webkit
bun run --filter @epicenter/blobs typecheck
bun run --filter @epicenter/app typecheck
bun run --filter @epicenter/whispering typecheck
```

Recheck script/package names against the live tree before execution. Add a
Chromium run and the platform-specific publication tests; the existing WebKit
script is not cross-browser or installed-desktop evidence.

### Remove retired code and close the plan

- [ ] After proof, remove unused directory-backed publication and JSON sidecar
  codecs, paired IndexedDB write paths, obsolete exact-MIME round-trip tests,
  extensionless mint/parse paths, and stale attachment-ID acceptance with no
  live producer. Keep required recovery/export tooling only if the approved
  existing-data decision calls for it.
- [ ] Search production and tests for `metadata.json`, `blob-data`,
  `blob-metadata`, extensionless ID assumptions, and native `data` path joins.
  Classify historical fixtures separately; do not delete stored files because
  a string remains in a preservation test.
- [ ] Update package READMEs to describe the implemented layout, reconcile the
  native-capture plan's obsolete finished-file handoff, and remove outdated
  examples. Do not change concurrent native admission or App API scope as part
  of this pass.
- [ ] Rerun focused checks and repository checks, reporting baseline failures
  separately. Compare the result to the one-sentence target. Delete this spec
  when its required work is complete; retain the durable decisions in the ADRs.

## Boundaries and unresolved gate

The existing-data disposition is the only product gate to the cutover in this
plan. Work on isolated adapters and fixtures can proceed before that decision;
changing live validators, stored references, or active readers cannot.

The prior media-sync/backups exploration does not authorize deleting backups,
restore, or generation handling. The concurrent native-capture plan owns device
admission, not a second byte-storage destination. The App device/account and
platform-selection plans remain separate. Public sharing grants, automatic
upload, deduplication, crash-before-Stop recovery, and an audio recovery UI are
not added by this storage-layout change.
