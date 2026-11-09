# 0640. Future media sync uses Git LFS and one endpoint pair

- **Status:** Proposed
- **Date:** 2026-10-19
- **Relates:** [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text-only v1 and later LFS), [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (optional synchronization and supported hosts), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (content merge), and [ADR-0620](0620-history-in-a-repository-only-grows.md) (Git history retention).
- **Implementation:** [Future Git LFS media synchronization](../../specs/20261019T183449-git-lfs-media-sync.md).
- **Unbuilt:** Epicenter's LFS service and authorization, native and browser LFS integration, durable transfer state, pointer merge classification, media availability and download controls, retention policy, and opt-in migration of existing recordings.

## Context

Whispering saves recording metadata and transcripts as Markdown. Its recording
row names local audio through a relative `audioPath`. The first release
synchronizes text; original recordings remain local. That release boundary
does not require choosing a proprietary media format later.

Git LFS stores a small canonical pointer in Git and transfers the original
bytes through a separate service. Its object ID identifies content, not the
service holding it. Desktop native tools can reach more providers than a
browser client whose supported Git service is Epicenter.

The existing native runner disables hooks, and the folder engine neutralizes
or refuses LFS filters. The hosted Git router implements no LFS endpoints.
Installing `git-lfs` does not supply Epicenter's missing integration.

## Decision

**Future managed media synchronization uses standard Git LFS on both clients.**
Epicenter provides an LFS-compatible service; the browser implements its Batch
and basic HTTP transfer protocol. Desktop delegates supported native LFS work
to `git-lfs`. There is no separate Epicenter pointer format or media manifest
in recording rows.

**Each connected repository uses one configured Git/LFS endpoint pair.**
Epicenter Git with Epicenter LFS is the default supported pair for browser and
desktop. Desktop can instead use another compatible configured Git/LFS pair,
normally deriving LFS discovery from the Git remote. Native configuration can
select a separate endpoint where supported; the first product interface does
not add cross-host pairing or automatic mirroring. Browser synchronization
supports only the Epicenter pair initially.

Both clients must reach the same repository and its paired media store to
exchange a recording. Moving Git refs alone does not move LFS objects. An
external-host repository is not browser-accessible merely because someone
also has an Epicenter account or media allowance. Moving it to supported
hosting requires a deliberate transfer of Git history and referenced media.

**The recording row keeps its relative `audioPath`.** The LFS pointer is the
canonical remote hash-and-size description for that path. Recording rows
contain no signed URL, upload session, or duplicate hash-and-size fields for
transfer. Local presence, pending uploads, and progress are device-local
state. Native audio remains an ordinary playable file; browser bytes remain
in app-local storage until a separate media API is implemented. This decision
adds no generic binary-write API to the v1 folder library.

**Local saves do not wait for media delivery.** Epicenter's managed publication
uploads and verifies the media required by the exact commits it will push
before publishing their pointers. A failed upload preserves local originals
and pending work. Text in a commit introducing media can wait with that
commit; independent text delivery during media failure is not promised.
Remote media receipt and Git publication are separate acknowledgments, not
one atomic transaction. The service must retain pending uploads long enough
for publication retries.

**An LFS pointer is an indivisible merge unit.** The future integration
classifies supported LFS-managed paths before the ordinary text-region merge.
It chooses one competing pointer under the deterministic competition policy;
it does not join two pointers or independently merge their hash and size.
Overridden committed versions retain the normal history and diagnostic path.
Unsent originals remain recoverable locally.

**Media availability is explicit.** Local reads do not silently download an
archive. A client distinguishes playable local bytes from a recording that
needs downloading or cannot be retrieved. It verifies downloaded content
before materializing it and does not overwrite a newer local original with a
late download. A Git pointer alone is not evidence of remote byte availability.
Offline and unsent browser recordings retain an account-independent export
and recovery path; successful upload followed by clone is not that path.

**The supported initial contract is bounded.** Completed recordings are uploaded
as original bytes without transcoding. Custom transfer adapters, LFS locking
and extensions, every provider's browser authentication, automatic cross-host
replication, full-archive hydration, and uploads after a phone browser closes
are outside the initial integration. Native tools can have broader features
without making them Epicenter product guarantees.

**This is future, opt-in work.** The first release keeps local recordings and
text synchronization. Neither signing in nor connecting text synchronization
uploads existing audio. Media activation needs explicit consent, a retention
and deletion contract, and migration that preserves originals. Git history
retention does not imply indefinite LFS-object retention. Pricing and included
storage allowances are separate product decisions.

## Consequences

- One portable pointer and transfer standard serves both clients. Different
  provider support does not require different repository formats.
- Native integration explicitly performs LFS work instead of enabling arbitrary
  repository hooks. Browser integration owns local media persistence and retries.
- The future pointer classification narrows the all-text merge rule only for
  supported LFS paths. Its amendment and the media opt-in policy must land
  before integration; the accepted v1 rules remain unchanged in the meantime.
- Hosted storage, repository-scoped access, CORS on API and transfer URLs,
  quota handling, and retention remain implementation responsibilities.
- Ordinary Git plus LFS can retrieve published recordings when credentials,
  endpoint access, and retained objects permit it. A plain Git clone alone
  retrieves pointers.

## Considered alternatives

- **An Epicenter-specific browser blob protocol.** Controls browser transfers
  but creates another portable reference convention and a native-tool bridge.
- **Every desktop LFS configuration in the browser.** Adds provider credentials,
  endpoint discovery, transfer variants, and CORS dependencies to the browser.
- **GitHub text with automatically mirrored Epicenter media.** Adds two-service
  permissions and reconciliation before the supported same-pair journey works.
- **LFS in the first text-sync release.** Adds media service and client work to
  a release explicitly allowed to keep originals on their recording device.

## Sources

- [Git LFS pointer format](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md).
- [LFS server discovery and endpoint configuration](https://github.com/git-lfs/git-lfs/blob/main/docs/api/server-discovery.md).
- [LFS Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md).
- [LFS basic HTTP transfers](https://github.com/git-lfs/git-lfs/blob/main/docs/api/basic-transfers.md).
