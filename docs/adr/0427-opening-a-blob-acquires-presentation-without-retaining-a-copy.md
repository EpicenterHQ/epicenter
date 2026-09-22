# 0427. Opening a blob acquires presentation without retaining a copy

- **Status:** Accepted
- **Date:** 2026-09-22
- **Implementation (2026-09-22):** The scoped API and transport are implemented. Whispering uses store-owned blobs and scoped copy references; product playback-worker registration remains deferred; see the [verification report](../reports/20260922-store-owned-blobs-implementation.md).
- **Amends:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) at mandatory presigned/redirected read transport; [ADR-0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md) at the claim that plaintext alone provides ranged playback. Consumer-owned encryption remains unchanged.

## Context

HTML audio/video elements consume URLs. They can request parts of a remote
object and seek without retaining the complete object in application storage.
A browser Blob URL, an authenticated host-file route, and a remote playback URL
can satisfy one player interface while using different transports.

The previous remote `open` called `get`, waited for `response.blob()`, and created
an object URL. Its cloud GET did not forward Range to object storage. Requiring
all playback to publish locally would add disk/quota failures and permanent
retention without fixing those delivery limitations.

## Decision

**`open(blobId)` acquires presentation access; only explicit copying promises a
new persistent placement.** Both local and remote return the same disposable
`BlobSource`: a `url` usable by the relevant HTML media element and idempotent
release. Acquire asynchronously, attach the URL, and release when the consumer
stops using it. The resource may return an object URL, host route, or authorized
remote endpoint. Applications do not branch on URL schemes or fetch credentials
on behalf of a player.

`get` returns complete bytes for computation.
`local.blobs.copyFrom(personal.blobs, id)` retains a complete local copy under a fresh returned ID before
success. `personal.blobs.open(id)` must not require
that copy or claim offline availability. Browser buffering/HTTP caching is not
application-controlled retention. Playback can outlive a network connection
only to the extent already received data permits; there is no implicit pinning,
eviction policy, cache metadata, or synchronization queue.

Blob access belongs to the opened store under ADR-0372. Acquiring
`personal.blobs` requires Personal store readiness, including its document;
opening media adds no local blob-retention requirement. Closing the owning store
releases its presentation sources. Consumers release individual sources when
finished without closing the borrowed blob capability or store.

### A locator is not playback authority

A remote address identifies server, principal, namespace, and BlobId. Account
credentials authorize access. A media element's own requests do not call
`Account.fetch`; an arbitrary bearer cannot be supplied through `src` or the
`crossorigin` attribute. Thus `url(id)` string construction is not the public
replacement for `open`.

The implementation must acquire a media-consumable authorization path bound to
the selected object and account. The browser and desktop may use different
mechanisms. The existing desktop relay is useful transport evidence, not proof
of account-pinned media lifetime: later requests must never select a successor
account. Do not embed account bearers in persisted rows, public URLs, or logs.
Temporary playback credentials are capabilities, not durable blob references.

Before exposing remote sources, prove authorization for subsequent range/HEAD
requests, pause/seek after expiry, cancellation, disposal, and account retirement.
Choose and record one supported delivery mechanism per runtime. Short-lived
scoped grants trade server state for a remaining validity window; revocable
sessions trade that window for state and cleanup. Do not silently weaken the
existing captured-account boundary to fit either mechanism. A policy requiring
user judgment, such as continued remote access after sign-out, must be resolved
before dependent implementation. Disposal releases owned resources; it cannot
retract received bytes and must not claim remote revocation without enforcement.

### Efficient playback is an end-to-end property

Remote delivery must support the media formats actually used, byte-range
requests, correct 206/416 responses, lengths, and appropriate HEAD behavior.
Preserve object version consistency across requests. Forwarding a URL while
buffering the entire object underneath does not establish streaming acceptance.
Successful `open` establishes source acquisition, not future playback success.
The player handles later media-element errors and offers deliberate reacquisition
where appropriate; resource Results cover acquisition failures.

Keep authentication, `nosniff`, and safe serving of untrusted content. Do not
remove attachment/sandbox protections indiscriminately to make a media test pass.
An uploaded HTML or SVG file must not gain application-origin script authority
through the presentation endpoint. Test MIME/container support on actual target
browsers, including seek behavior, rather than promising playback for all bytes.

The current 25 MiB upload cap and server full-body accumulation are separate
limitations. Raising a number or changing `open` does not establish large-video
creation/transfer support. Explicit payload limits and streaming publication
must be verified across edge, server, object provider, host, and browser storage.

## Consequences

One player consumes one source contract; local and remote transports retain the
behavior their locations require. Remote viewing can begin without enough local
space to save a complete file. Applications can offer a separate keep-offline
action using `copyFrom`. Copying locally makes bytes survive account sign-out;
playing remotely makes no such promise.

The implementation gains a private-media delivery boundary with lifetime and
range tests. It loses full-download-before-playback as the mandatory remote
path and avoids mandatory caching, retention classes, and local publication
races during playback. The public API remains in
[ADR-0372](0372-local-and-remote-blobs-open-independently.md).

## Considered alternatives

- Always download before playback: coherent for a product that promises every
  opened object offline, but prevents efficient viewing of large remote media.
- Return a synchronous remote URL: hides authentication and later-request lifetime.
- Make objects public so HTML can fetch them: changes access control to simplify
  transport, outside the intended private-account contract.
- Put access tokens in durable row references: confuses storage identity with
  credentials and makes expiration a data-repair problem.
- A separate player API for each runtime: makes components own storage transport.
