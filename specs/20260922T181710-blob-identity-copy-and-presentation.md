# Blob identity, copying, and presentation

**Date**: 2026-09-22
**Status**: Draft
**Owner**: Epicenter maintainers

## One sentence

Independent blob stores create identities with `add`, preserve saved objects with
`copyFrom`, read bytes with `get`, and acquire presentation with `open`.

This is the active implementation plan for the blob API decision. Current code
has independent handles but still uploads under a fresh remote ID and downloads
all remote media before playback. Completion requires the real application
workflows, immutable transfer, and authorized media delivery to satisfy the
contracts, not merely new method names or passing library tests.

Read the [copyable handoff](20260922T181710-blob-identity-copy-and-presentation.handoff.md)
for a fresh execution session. Read the decisions below for the target; use code
and package READMEs to reconstruct the changing implementation.

## Decisions and scope

| Boundary | Record | What it settles |
| --- | --- | --- |
| Public operations and copy lifetime | [0372](../docs/adr/0372-local-and-remote-blobs-open-independently.md) | Independent constructors; add/copyFrom/get/open; private publication; supported-source validation |
| Identity, location, physical addresses | [0426](../docs/adr/0426-blob-identities-survive-copies-between-scoped-locations.md) | Opaque extension-bearing IDs survive copying across namespaces; scope is not identity or authorization |
| Presentation and retention | [0427](../docs/adr/0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md) | One disposable source contract; remote opening does not require durable local storage |
| Local publication | [0349](../docs/adr/0349-local-blobs-belong-to-the-app-on-this-device.md) | Flat files/IndexedDB, atomic publication, local enumeration |
| Recorder destination | [0366](../docs/adr/0366-a-recorder-captures-into-its-explicit-local-blob-destination.md) | Inert recorder borrows local storage; Stop publishes before row creation |
| Row references | [0393](../docs/adr/0393-rows-refer-to-blobs-without-owning-their-lifetime.md) | Rows retain sufficient placement scope; byte lifetime remains independent |

These are the requested design direction. Formal ADR statuses remain separate
from implementation state. Do not change statuses to silence documentation lint.

This plan replaces earlier blob-specific instructions requiring local staging
for all remote creation, fresh upload IDs, URL-addressed SDK reads, or a mandatory
`ReferenceNotSaved` recovery flow. It does not replace the separate page/host,
inference, transcript, or recording-controller work in other active plans. A
remaining placement-reference write can still fail after copying: preserve that
partial success. Removing a second ID does not remove every reference write.

## Addresses and intended workflows

```text
Local browser: origin/profile + namespace + BlobId
  IndexedDB epicenter/<namespace>/device/no-account/blobs
  blobs[blobId] = { id, bytes, size }

Local desktop: dataRoot + namespace + BlobId
  <dataRoot>/apps/<namespace>/device/no-account/blobs/<blobId>

Remote: authority + principalId + namespace + BlobId
  bucket key: principals/<principalId>/apps/<namespace>/blobs/<blobId>
  locator: <server>/api/apps/<namespace>/principals/<principalId>/blobs/<blobId>
```

The bucket belongs to the deployment. `<principalId>` is the account's principal,
not email or token. Namespace `id` uses the existing application-ID grammar.
BlobId is a complete opaque extension-bearing key. Paths retain existing bytes;
this API change does not authorize physical relocation or data migration.

The workflows to prove are:

1. Add/import or record locally while signed out; play locally after reopen.
2. Add supplied bytes directly to a remote store without acquiring local storage.
3. Copy local to remote with the same ID, including a different destination namespace.
4. Play remote-only audio/video through a disposable URL without a local write.
5. Copy remote to local under the same ID, then play offline.
6. Copy between local namespaces without changing ID or touching the source.
7. Read bytes for transcription without requiring durable local download.
8. Delete one placement while leaving rows and other placements alone.

The openers stay independent. Remote does not accept LocalBlobs at construction.
No public `put`, destination-ID override, top-level `copyBlob`, upload/download
alias, or generic resource/transfer manager is part of the target.

## Current evidence and mismatches

| Evidence | Observed behavior | Required work |
| --- | --- | --- |
| `packages/app/src/blobs.ts` | Remote fixes namespace/account; upload accepts LocalBlobs; both handles track transfer | Preserve ownership while changing the public transfer contract |
| `packages/blobs/src/owner.ts` | Local add mints ID; raw put is private to application callers | Preserve producer capability; do not export arbitrary-ID publication |
| `packages/blobs/src/browser.ts` | No-account public opener; ArrayBuffer-backed records | Atomic same-ID copying, conflicts, concurrent copy behavior |
| `packages/blobs/src/bun.ts` | Private staging, descriptor reads, putRequest/putResponse; ordinary get uses arrayBuffer | Reuse streaming publication rather than route saved files through full-byte reads |
| `packages/blobs/src/webview.ts` | get waits for response.blob; local open uses host URL | Keep complete-byte get separate from presentation/transfer |
| `packages/client/src/index.ts` | Remote get waits for blob; open creates object URL; URL pins account/app | Replace URL-addressed public operations without weakening captured authorization |
| `packages/server/src/routes/blobs.ts` | Fresh ID allocation; 25 MiB cap; whole-body accumulation; GET ignores Range | Same-ID publication and collision handling; real private media transport |
| `packages/server/src/s3-blob-store.ts` | Conditional create; occupied key is an error; get lacks Range | Verified identical retry and end-to-end range semantics |
| `apps/epicenter/src/server.ts` | Native upload streams actual source file; local media supports ranges; relay reads current account | Preserve source provenance, pin remote media to captured account, implement native download publication |
| `packages/auth/src/desktop-broker-auth.ts` | Request body is prepared as complete Blob for WebKit | Preserve host-side copy; a public stream parameter alone does not remove this barrier |
| Whispering recordings/upload/player | Local-ID plus remote URL; duplicated local-first resolution; upload then row patch | Scope-aware same-ID workflows and later media-element error handling |

A Blob does not imply a fixed number of JS-heap copies. The observed whole-body
barriers and explicit ArrayBuffer paths justify keeping native transfer. Measure
latency and combined process memory before making performance claims. Efficient
native upload alone does not remove buffering at the server.

No runtime verification was performed by this documentation task. Previous task
test counts are historical, not evidence for this target.

## Call sites: before and after

These excerpts are from the documentation task's baseline; recheck them before
implementation because other work is active. After examples are target sketches
with Result handling, not existing exports.

### Retain saved audio remotely

Before, `apps/whispering/src/lib/operations/upload-recording.ts:43`:

```ts
return app.remoteBlobs.upload(app.localBlobs, recording.audioBlobId, {
  signal,
});
```

After:

```ts
const copied = await remote.copyFrom(local, recording.audioBlobId, { signal });
if (copied.error) return copied;
// Publish placement metadata only if context does not already determine it.
return copied;
```

The transfer returns no new remote ID or URL. If the row still needs remote scope,
its publication remains a separate operation whose failure retains copy identity
and destination scope. Do not automatically upload again to repair that write.

### Present remote-only audio

Before, `apps/whispering/src/lib/whispering/recordings.ts:77`:

```ts
const local = await localBlobs.open(audioBlobId);
if (local.error?.name !== 'BlobNotFound' || !audioUrl || !remoteBlobs)
  return local;
return remoteBlobs.open(audioUrl);
```

After, only after resolving the row's remote placement to the proper handle:

```ts
const opened = await local.open(audioBlobId);
if (opened.error?.name !== 'BlobNotFound') return opened;
return remote.open(audioBlobId);
```

Missing bytes may permit an explicit remote attempt; corruption/quota/IO failure
must not be relabeled as absence. Do not select the currently signed-in account
as a substitute for a stored remote owner. `AudioBlobPlayer.svelte` still consumes
`source.url` and releases it; add handling for failures after source acquisition.

### Save imported audio and keep an existing remote object offline

Before, `apps/whispering/src/lib/operations/save-audio-recording.ts:21`:

```ts
const saved = await app.localBlobs.add(audio);
if (saved.error !== null) return saved;
```

After for new imported/generated bytes, that `add` call stays. Copying an existing
remote identity is a different operation:

```ts
const copied = await local.copyFrom(remote, blobId, { signal });
if (copied.error) return copied;
return local.open(blobId);
```

Neither copying nor opening creates a recording row. `get` followed by `add`
intentionally creates another identity; it must not implement same-ID download.

## Execution waves

Every review covers cumulative behavior and remaining work. Resolve grounded
findings, update this plan, and continue. A review checkpoint is not a stopping
point. Use two read-only independent reviewers per adversarial-review; report
runtime limitations when fresh reviewers are unavailable. Codex owns edits and
integration. Use parallel agents for bounded caller/protocol/test investigations,
not simultaneous mutations of shared ownership code.

### Wave 0: Capture the live baseline and settle evidence gates

- [ ] Capture git status, name-status, binary working/index diffs, untracked files,
  and relevant diagnostics. Preserve unrelated changes; never infer ownership
  from dirty status. Re-read source and nearest README, not only these excerpts.
- [ ] Map source/destination pairs, publication owners, account transport, actual
  native directories, and every public upload/get/open/delete caller.
- [ ] Decide supported remote-to-remote copy behavior before accepting RemoteBlobs
  as a source for a remote destination. Required pairs are local/local,
  local/remote, and remote/local, including cross-namespace copies. Unsupported
  pairs must be excluded by types or refuse before side effects.
- [ ] Prototype the identity/collision and private-media delivery boundaries below.
  Record exact protocol choices and limits, using current types/official docs.
- [ ] Adversarial checkpoint: scope/provenance, collision equality, account lifetime,
  and delivery policy before broad API/caller migration.

### Wave 1: Build immutable publication and identity-preserving copy

- [ ] Implement same-ID atomic publication and verified identical retry handling.
  Preserve conventional format validation, complete keys, and local path bytes.
- [ ] Keep arbitrary-ID publication private; do not preserve an internal method
  merely for symmetry. Keep actual producer/adapter boundaries that own safety.
- [ ] Define ambiguous commit outcomes, including remote add's minted ID and
  destination scope when publication may have succeeded. One admitted add keeps
  one chosen ID; a new add is not an automatic retry of an unknown prior creation.
- [ ] Prove fresh creation, identical/different occupied keys, concurrent writes,
  source deletion races, and interrupted publication without partial final bytes.
- [ ] Adversarial checkpoint before transfer integration: no existence-only
  success, no new global-equality claim, no accidental overwriting or cleanup.

### Wave 2: Build independent resource operations and transports

- [ ] Implement remote add, ID-based reads/deletes, and destination copyFrom with
  concrete source provenance and admission tracked by both handles.
- [ ] Preserve host-side native upload; implement native remote-to-local streaming
  into the atomic publisher. Browser complete-Blob fallback must keep the same
  identity, result, cancellation, and collision semantics.
- [ ] Prove cross-namespace copies use actual source/destination scopes and bytes.
  A test/custom source cannot masquerade as a same-named native file.
- [ ] Check exact Account capture, unsupported-pair refusal, descriptor cleanup,
  handle-close races, and lost responses after destination commit.
- [ ] Adversarial checkpoint before callers: compare API behavior across transports;
  remove neither source validation nor native efficiency for interface symmetry.

### Wave 3: Build and prove remote presentation

- [ ] Implement the chosen private playback mechanism behind asynchronous open.
  URL derivation alone is not authentication. Prevent successor-account retargeting.
- [ ] Carry Range/HEAD and partial statuses/headers end to end. Retain safe content
  serving. Validate actual supported containers/codecs in browsers and WebViews.
- [ ] Establish expiry, pause/seek, release, and account-retirement behavior. Treat
  required policy changes as user decisions; do not silently accept weaker access.
- [ ] Measure remote start/seek before full download and no durable local writes.
  Explicit copy must still fail honestly on quota while remote playback works.
- [ ] Review upload-size policy and whole-body buffering separately. Do not claim
  large-video transfer without a tested accepted size and bounded resource use.
- [ ] Adversarial checkpoint on delivery, content safety, and lifetime before
  deleting the full-download presentation implementation.

### Wave 4: Migrate real application workflows

- [ ] Update recording/import, upload, playback, byte-based transcription,
  availability, downloads, and deletion consumers; inspect other blob clients.
- [ ] Decide remote placement representation for Local versus Personal rows before
  schema changes. Preserve sufficient authority/principal/namespace and no tokens.
- [ ] Remove audioUrl and post-copy mutation only where enclosing context really
  determines placement. Otherwise retain ordinary credential-free metadata and
  partial-success recovery. Presence indicators must not assume perpetual copies.
- [ ] Preserve Stop/row failure receipts, exact capture targeting, usable transcript
  outcomes, and one presentation owner. Copy and playback never create rows.
- [ ] Stop importing old paths once target workflows exist. Leave old code unused
  only long enough to verify replacement, not as public compatibility aliases.
- [ ] Adversarial checkpoint through real UI/command callers and all deletion
  candidates, including scope changes and media errors after open succeeds.

### Wave 5: Verify, remove, document

- [ ] Pass focused package/consumer types, storage/transport tests, browser smoke,
  real native transport checks, and media acceptance. Attribute failures against
  the captured baseline; distinguish mocks from physical/device evidence.
- [ ] Delete obsolete upload/addFrom/addLocal entrypoints, new-remote-ID mapping,
  URL recovery machinery only where unnecessary, and obsolete presentation paths.
- [ ] Run local post-implementation-review after repairs. Recheck stale names,
  exports, examples, and unsupported source combinations.
- [ ] Update current package READMEs and ADR implementation notes. Retire this plan
  and handoff when spent, recording history under repository conventions. Do not
  mark a spec Done or promote ADR status as a completion action.

## Remaining implementation choices

The public method names, independent acquisition, explicit retention, and scoped
identity are settled. The implementer should choose mechanics from evidence;
these gates must not be buried as incidental implementation details:

- Equality: compare bytes or use trusted verified digest metadata under atomic
  publication. Never infer equality from ID/size alone. Cross-authority opaque IDs
  are not a cryptographic integrity scheme; do not silently substitute local bytes
  for an unrelated external reference.
- Media authority: prototype a scoped grant or authenticated runtime route with
  concrete expiry/disposal behavior. If it permits access after required account
  retirement, explain that policy consequence before proceeding with that choice.
- Large media: establish deployment/provider limits and storage strategy. The
  existing 25 MiB cap is current behavior, not an agreed replacement maximum.
- Placement references: choose where non-inherited scope lives in actual Local
  rows. Removing strings is not a win if callers lose the ability to find content.
- Remote copy matrix: do not accidentally promise arbitrary remote proxying or
  cross-account creation. Each advertised pair requires two authorized scopes.

## Verification and completion evidence

Use Bun and inspect current scripts first. Likely focused commands include:

```sh
bun test packages/blobs/src
bun run --cwd packages/blobs typecheck
bun test packages/client/src/index.test.ts packages/client/src/blob-format.test.ts
bun test packages/server/src/routes/blobs.test.ts
bun test apps/epicenter/src/account-transport.test.ts
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd apps/whispering typecheck
bun run --cwd packages/app smoke:recording
bun run --cwd packages/blobs smoke:webkit
bun scripts/check-doc-hygiene.ts
git diff --check
```

Recheck native smoke scripts before use; they may require Cargo, FFprobe, and
FFmpeg. Run Whispering operation tests from its working directory so its aliases
resolve. Add meaningful contract tests where behavior changes, not forwarding
method tests that reproduce the implementation.

Completion evidence must show: signed-out recording and reopen; direct remote
creation; identical IDs and exact bytes in both copy directions and namespaces;
conflict/concurrency/cancellation outcomes; no WebView payload detour on native
copy; authorized remote start and seek before full transfer; no local persistence
from open; explicit offline copy; correct account scope after replacement; safe
untrusted content; later player error presentation; and no stale public aliases.
Report tested limits and any remaining blockers. No benchmark or physical/device
acceptance can be inferred from unit test counts.

## Documentation preparation evidence

The documentation task captured its starting state under
`/tmp/epicenter-blob-doctrine-20260922T181710`. That is a documentation baseline,
not an implementation baseline or a portable dependency. Source inspection found
substantial unrelated dirty/untracked work, including active resource/lifecycle
implementation. A new execution must capture its own state. Only documentation
was authorized for this preparation commit; no deployment or data migration ran.
