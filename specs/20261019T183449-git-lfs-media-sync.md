# Future Git LFS media synchronization

**Date**: 2026-10-19
**Status**: Draft
**Owner**: Codex

## One sentence

Add opt-in original-recording exchange through standard Git LFS, using the
Epicenter Git/LFS pair on browser and desktop and compatible configured pairs
on desktop.

## Delivery boundary

This is future work after local saving and text synchronization. It does not
gate the [browser repository engine](20261019T190000-browser-repository-engine.md)
or move audio into the first release. The durable direction is
[ADR-0640](../docs/adr/0640-future-media-sync-uses-git-lfs-and-one-endpoint-pair.md).

The first implementation slice proves one authenticated browser-to-native
recording exchange without migrating production data. Completion means both
directions work through the real Epicenter LFS endpoints, exact bytes survive
interruptions and retries, and ordinary native LFS tools restore the files.
The broader app feature also needs opt-in migration, availability UI, and
retention and deletion policy.

## Current state

The relevant source entry points are:

| Source | Existing behavior and implementation seam |
| --- | --- |
| `apps/whispering/src/lib/definition.ts` | Recording rows name audio by relative `audioPath`; `audio/` is excluded from managed Git history. |
| `apps/whispering/src/lib/workspace/browser.ts` and `desktop.ts` | Playback and transcription acquire the bytes named by the row. Standalone migration remains separate work. |
| `packages/data/src/repository.ts` | Browser file writes accept text; reads return Git or pending content as a `Blob`. There is no media-upload API. |
| `packages/data/src/sync.ts` | One exact pending commit can be in flight while newer local saves remain durable. |
| `packages/data/src/merge.ts` and `content/merge-lines.ts` | Non-Markdown UTF-8 content uses region merging with simultaneous-insertion union. LFS pointers need a whole-file classification. |
| `packages/folder/src/git/native-host.ts` | Native commands disable hooks, including an ordinary LFS pre-push hook. |
| `packages/folder/src/git/neutral-attributes.ts` and `attributes.ts` | Existing paths neutralize or refuse filters; installing LFS does not change the commit path. |
| `packages/server/src/routes/git.ts` | The router accepts Git smart HTTP endpoints, authorizes repository requests, and provisions storage on first Git push. No LFS route exists. |
| `apps/api/worker/git-repositories.ts` | Hosted Git delegates to Cloudflare Artifacts. LFS requires its own implemented object service, not an assumed Artifacts capability. |

The proposed folder and local-audio records remain separate prerequisites to
resolve against implementation: [folder opening](../docs/adr/0636-an-app-opens-local-files-through-one-folder-handle.md),
[desktop audio placement](../docs/adr/0637-whispering-keeps-desktop-audio-in-its-selected-directory.md),
and [automatic non-text commit policy](../docs/adr/0639-automatic-commits-refuse-new-non-text-content.md).
Do not infer a generic binary folder API from this plan. The native recorder
owns native bytes; browser media remains app-local unless a separate contract
changes that ownership.

## Target shape

```text
Browser Whispering                         Desktop Whispering / ordinary tools
  local text + app-local audio               working files + native Git/LFS
          |                                             |
          +------ Git commits ------ Epicenter Git -----+
          +------ Batch / bytes ---- Epicenter LFS -----+

Desktop with external hosting:
  native Git + git-lfs ------ configured Git/LFS pair
```

Keep the Markdown `audioPath` unchanged. A committed audio path contains a
canonical LFS pointer; its hydrated desktop file contains actual audio.
Browser media storage retains the original separately from that pointer.
Local queue state maps the path and recording to the bytes and object identity
without becoming another synchronized manifest.

The managed publication sequence is local recording, durable local save,
hashing, upload and verification, then publication of the exact Git commit
introducing the pointer. Receiving clients acquire pointers first and download
selected originals explicitly. A media failure can delay text in the same
pending commit, but not local saving. Do not add partial-commit scheduling to
promise independent text publication in that case.

## Implementation plan

### 1. Establish the service contract with one recording

- [ ] Keep the v1 local-only audio and text-sync behavior intact. Resolve
  ADR-0640 and add the reciprocal amendment links when it governs implementation:
  ADR-0621's future media boundary, ADR-0622's whole-pointer exception, and
  ADR-0633's endpoint-pair behavior. Edit still-proposed local-audio and automatic
  commit records directly if their implementation scope changes; do not cite
  them as superseded accepted decisions.
- [ ] Define repository-scoped Batch upload/download and basic GET/PUT actions.
  Reuse repository authorization decisions for native credentials and browser
  grants; a content hash alone grants no access. Name object availability,
  verification, quota, and expired-action failures.
- [ ] Choose first-repository ordering: explicitly provision it or push initial
  text before the first media upload. The Git route's first-push creation cannot
  be silently assumed to precede an upload-before-pointer sequence.
- [ ] Implement temporary service-backed object storage with verified hash and
  size. Permit browser requests at both the Batch endpoint and returned transfer
  URLs. Keep action URLs and credentials outside synchronized files.
- [ ] Transfer a completed recording from a browser origin to this service,
  publish its pointer through Git, and restore it with ordinary `git-lfs`.
  Reverse direction once. Record exact versions, hashes, requests, and limits.

### 2. Integrate durable publication and native LFS

- [ ] Define the completed-recording upload queue and its persisted ownership of
  local bytes. Reopening, sign-out, account changes, and failed uploads preserve
  originals. Retry uncertain acknowledgments by identity and verification.
- [ ] Inspect every commit being published for required LFS objects, not only
  the newest working-file changes. Upload required objects before Git push;
  preserve the exact pending commit through uncertain Git acknowledgments.
- [ ] Retain uploaded-but-unpublished objects across publication delays and
  retries. Decide collection eligibility before enabling collection.
- [ ] Integrate supported native `git-lfs` commands explicitly without enabling
  arbitrary repository hooks. Reconcile filter neutralization, cleaned pointer
  construction, materialization, ignore rules, and non-text preflight together.
  Missing tools and unsupported configuration produce actionable diagnostics.
- [ ] Classify supported LFS-managed paths before region merging. Select one
  whole competing pointer, preserve history and diagnostics, and retain unsent
  original bytes. Do not merge `oid` and `size` independently or concatenate
  simultaneous pointer creations.
- [ ] Support one configured endpoint pair per repository. Derive native
  discovery from its remote or supported explicit configuration. Keep the
  browser bound to Epicenter; reject unsupported endpoint overrides visibly
  without deleting data or falsely reporting audio delivery.

### 3. Expose app behavior and migrate deliberately

- [ ] Define the smallest media interface for local presence, transfer status,
  explicit download, and reading/playback. Ordinary text reads remain local;
  pointer text is not playable audio. Do not invent a universal binary API as
  an incidental implementation detail.
- [ ] Download to temporary local storage, verify content, and materialize only
  if the selected recording/path still names that object. A late download must
  not overwrite a newer local file or user edit.
- [ ] Add explicit opt-in for media synchronization and migration of selected
  existing recordings. Preserve originals and text while transferring; do not
  rewrite old history or silently publish the entire archive.
- [ ] Keep account-independent recovery/export for offline or unsent browser
  audio. Upload followed by Git clone covers only successfully published work.
- [ ] Define retention, record deletion versus local-download removal, old
  pointer availability, quota, and access after service lapse before release.
  Payment does not change local-save semantics or inference authorization.
- [ ] Switch consumers only after readback and recovery checks pass. Update
  package READMEs and the relevant ADR amendment links with the implemented
  boundary; remove this spec when the work is complete.

## Verification

Use disposable repositories and storage. The release proof must cover:

- Browser upload/native fetch and native upload/browser download with identical
  original bytes, canonical pointers, normal native credentials, and an ordinary
  clone using Git LFS. Test API and object-transfer CORS separately.
- Local save before sign-in, reopen with unsent originals, interrupted upload,
  expired transfer URL, lost upload acknowledgment, lost Git acknowledgment,
  first repository creation, quota failure, and newer local edits during each.
- Audio-upload failure prevents publication of its pointer and text in that
  commit while local text and audio remain readable. A retry publishes once.
- Two different recordings created concurrently at the same path remain valid
  whole-pointer competition, not concatenated pointer text. Independent normal
  Markdown edits still merge under the existing rules.
- Delayed downloads, local playback while offline, local-download removal, and
  explicit record deletion under the chosen retention policy.
- External Git/LFS pairs work on native targets; the browser reports unsupported
  pairs. Moving only Git history does not claim that media moved too.
- Opt-in preserves previously ignored audio. Migration and account-independent
  export include originals not yet uploaded. Transcription requests alone do
  not create a retained remote audio library.

## Evidence and limits

On 2026-10-19, a disposable loopback probe used `git-lfs/3.8.0`, a minimal
Batch/basic HTTP service, and two WAV originals. Native upload followed by
plain HTTP download and HTTP upload followed by native fetch/checkout both
returned exact bytes. The Git remote and LFS endpoint were separate, using
standard `.lfsconfig`. A separate native failure probe confirmed that an LFS
upload failure blocked the Git push, including its transcript, while the local
transcript remained intact.

These checks established protocol interoperability and native hook ordering,
not Epicenter integration. They did not test browser CORS, production auth,
phone persistence, interrupted transfers, quota, object retention, or migration.
The full-merge runtime probe was not run because the isolated snapshot lacked
its dependencies. Source inspection identified simultaneous-insertion union
as incompatible with competing pointer files; add the regression in phase 2.

Independent Codex and Claude reviews supported one LFS representation with
different provider support per platform. They identified native hook/filter
integration, first-push provisioning, uploaded-object retention, whole-pointer
merging, and offline browser export as work the standard does not remove.

## Open release decisions

- Choose retention and deletion semantics, including historical pointer access
  and uploaded objects whose Git publication never succeeds.
- Choose media allowance and pricing independently of inference and text sync.
- Choose download/pinning defaults and whether a verified remote copy ever
  permits automatic local eviction. Default to retaining originals until that
  policy is explicit; do not promise background completion on a closed phone.

The supported first media slice uses completed recordings, Batch/basic HTTP,
and the Epicenter pair. Cross-host mirroring, a mixed-host setup interface,
locking, custom transfers, transcoding, and full-archive replication are outside
that slice.
