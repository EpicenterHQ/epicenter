# Store-owned blobs implementation

The scoped API and transport are implemented. Product integration is deferred.
This milestone is not application-integrated or merge-ready. No commit,
deployment, data migration, or SQL projection is part of this change.

## Public contract

```ts
const local = await openLocal(localDefinition);
const personal = await openPersonal(personalDefinition, { account });
const recorder = createRecorder({ localBlobs: local.blobs });

const added = await local.blobs.add(file);
if (!added.error) {
  const copied = await personal.blobs.copyFrom(local.blobs, added.data);
  if (copied.error) throw copied.error;
  const presented = await personal.blobs.open(added.data);
  if (!presented.error) {
    audio.src = presented.data.url;
    // The consumer retains this callback and invokes it at teardown.
    const releasePlayback = () => presented.data[Symbol.dispose]();
    audio.addEventListener('ended', releasePlayback, { once: true });
  }
}
// The product closes recorder and stores when their working lifetime ends.
```

Both stores own tables, KV, and blobs. Borrowed blobs have no close or signal.
Local adds stat/list. Copy directions are Local from Local or Personal, and
Personal from Local. Definitions may differ. Copying preserves exact bytes and
BlobId; creation mints identity. Shared and Personal-to-Personal remain deferred.
Recorder Stop publishes locally, including an admitted Stop drained by Local
close. Standalone `openSqlite` remains separate; `projectSqlite(store)` is unbuilt.

## Ownership and protocol

Store opening settles document and blob acquisition, including late success
following another failure. Failed or uncertain cleanup retains the store claim.
Admission closes synchronously before dependent abort callbacks run. Private
provenance maps admit genuine handles and preserve native source selection.

Immutable object PUT conditionally creates the supplied ID. An occupied ID
succeeds only after byte equality; concurrent disappearance is uncertainty.
Native copies retain descriptor snapshots and keep payloads out of the WebView.
Unknown publication outcomes carry identity and destination. Lost native
acknowledgments also retain both participants' claims until context teardown:
a rejected WebView fetch cannot prove host cleanup finished. Successful conflict
acknowledgment does not retain a failed-cleanup claim.

Personal `open` pins a strong ETag and length through HEAD. A page-owned source
streams later ranges through the captured Account. The shipped service worker
routes requests to their creating page and holds no credentials or stored bytes.
Unknown/disposed tokens return 410 immediately. Sources expire after five minutes;
continued playback requires deliberate reacquisition. Already delivered/decoded
bytes cannot be retracted. Account retirement stops authorization without closing
or deleting cached Personal documents.

Serve `@epicenter/client/blob-worker` at `/epicenter-blob-worker.js` and register
scope `/`. The desktop host embeds and serves the asset; product registration
remains deferred. Missing worker control fails presentation acquisition and does
not affect cached Personal opening. No full-download fallback was added.

The server supports HEAD, single byte ranges, If-Match, 206/416, and required
cross-origin headers. Attachment, sandbox, and nosniff protections remain.
Publication retains the 25 MiB cap. Large-video upload and real object-provider
acceptance are not established by these tests.

## Verification and baseline

Implementation began from the actual dirty checkout, overlaid into an isolated
worktree at `/tmp/epicenter-store-owned-blobs`. The snapshot and detailed logs are
in `/tmp/epicenter-blob-baseline-20260922`. The original index remained unchanged. All 65 task paths were integrated after
byte-for-byte comparison against that working baseline, with no conflicts. The
integration manifest records before/after hashes. Package and native-host
typechecks also pass in the requested checkout.

The initial ownership/import suite passed 25 tests and 89 assertions. Initial
app typechecking passed. Initial blob/client/routes passed 128 tests and 564
assertions; native account transport passed 17 tests and 95 assertions. Initial
doc hygiene reported 65 issues. Three product-startup tests already failed on
unresolved Wellcrafted imports in Whispering, Local Mail, and Vocab.

The final broad API run passes 990 tests and 3,700 assertions across 87 files,
with those same three startup failures. It includes all app, blobs, and client
tests, blob routes, CORS, and native account transport. Package typechecks for
app/blobs/client/server pass. Epicenter host TypeScript and Svelte checks pass
with zero errors/warnings. Another 45 native host-route tests pass with 459
assertions. The recording browser smoke confirms synthetic Stop,
decode, offline playback, cancellation, and reopening through `local.blobs`.
Physical microphone behavior is not established.

The private-media harness uses the shipped worker, real Account implementations,
production CORS/blob routes, and a local S3-protocol fixture. It serves a valid
1,920,044-byte WAV slowly. Chromium and WebKit run with separate frontend/API
origins. Native evidence uses an actual macOS WKWebView, `createHomeServer`, and
`createDesktopBrokerAuth`.

| Runtime | First advancing playback | First chunk | Seek target | Safety |
| --- | --- | --- | --- | --- |
| Chromium | 1,142 ms | 8,192 bytes | 118 seconds | HTML/SVG safe; cross-page 410 |
| WebKit | 802 ms | 8,192 bytes | 118 seconds | HTML/SVG safe; cross-page 410 |
| WKWebView | 790 ms | 8,192 bytes | 118 seconds | HTML/SVG safe through native host |

All three verify HEAD, 206, 416, independent acquisition, disposal, expiry,
version replacement, and retired-account refusal. Browser runs delivered less
than one quarter of the WAV across all tested requests. These timings describe
the local fixture, not production performance. The harness lives in
`packages/app/evidence/private-media`; set `MEDIA_ENGINE=chromium` or `webkit`.
`MEDIA_DESKTOP=1 MEDIA_SERVE_ONLY=1` starts the native fixture; its output supplies
the URL and temporary cookie for `wkwebview.swift`.

## Review decisions

Two independent Codex reviewers examined each checkpoint. The runtime's total
agent limit required reusing reviewers after the initial checkpoint; findings
were withheld until both initial verdicts arrived. No Claude review was requested. Both final reviewers accepted the scoped API
and transport; the queued documentation corrections were applied.

Repairs included synchronous admission fencing, recorder close rejection,
stream cleanup, empty-chunk equality, native acknowledgment validation,
reconciliation receipts, conservative native claim retention, pre-header
cancellation, desktop HEAD metadata, CORS, immediate token revocation, and
preserving genuine cancellation failures, including rejection with `undefined`.

The implementation removes standalone public blob owners, collection-upload
helpers, the full-download presentation path, a test-only Bun response writer,
and the forwarding-only `open.ts`. It avoids separate native presentation
registries, content-hash indexes, compatibility owners, and a generic transfer
framework. Definition inference and the private blob return generic remain;
removing them would erase precise Local/Personal types or duplicate opening.
Strict raw `put` remains distinct from idempotent copy publication.

## Deferred consumers and other failures

Whispering remains unchanged:

- `src/lib/whispering/resources.ts` imports removed `openLocalBlobs` and
  `openRemoteBlobs` and still composes separate blob owners.
- `src/lib/whispering/recordings.test.ts` imports `openLocalBlobs`.
- `src/lib/operations/upload-recording.ts` calls the removed upload method.
- `src/lib/whispering/recordings.ts` reads and presents stored remote URLs;
  new operations take BlobIds and captured placement.

Its typecheck reports 26 errors in three files, including missing exports and
cascading unknown Results. Two diagnostics in unchanged browser blob adapter
code are separate from consumer imports; their baseline attribution is unverified.
No product migration or compatibility constructor hides this breakage. Existing
product-startup tests were retained. Product worker registration and reference
composition require a separate authorized integration cut.

A combined invocation including the full host-route suite also produced a
between-suite module-resolution error for `@epicenter/device` from Local Mail.
The host-route suite passes independently in both checkouts (45 tests, 459
assertions). This combined-harness failure is unresolved; it is not counted as
a passing all-repository run.

Doc hygiene now reports 62 issues, down from 65 after the implemented blob
records were accepted. Remaining issues are outside this scoped change.
