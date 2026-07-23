# Trust model

Epicenter does not encrypt application data from the authority that
synchronizes it. Hosted Epicenter is trusted infrastructure: it can read
scalar record facts, Yjs document updates, immutable blob bytes, and the
metadata around those transfers. Self-hosting moves that authority onto
infrastructure you operate.

This is a topology decision, not an encryption setting.

## What stays local

Every runtime keeps a complete local replica. Local writes become durable and
remain usable offline before synchronization. Browser replicas live behind one
elected OPFS SQLite owner. Epicenter desktop owns one Bun SQLite replica and
raw blob directory; trusted WebViews reach it through a narrow record protocol.

Local ownership does not imply that synchronized bytes are opaque to the
server. Once a device publishes them, the authority can read them.

## What the authority sees

The authority sees:

- record addresses, scalar states, JSON payloads, sequence numbers, and
  submission timing;
- bounded Yjs document baselines and updates;
- immutable blob bytes and their digests;
- the authenticated principal, device or replica identifiers needed by the
  protocol, request sizes, timing, and network metadata.

This visibility lets the authority order facts, reject invalid submissions,
serve sleeping-device catch-up, enforce row and document lifecycles, and
produce complete portable Backups. It is app-blind in the sense that Lenses
remain application-owned, not content-blind.

## Hosted and self-hosted deployments

Epicenter Cloud resolves many authenticated accounts to principal partitions.
OAuth, billing, and hosted provider credentials live only there. Because
Epicenter operates that deployment, hosted data is inside Epicenter's trust
boundary.

A self-hosted instance has one partition behind an operator-supplied bearer.
It composes no hosted billing or multi-tenant OAuth. The operator controls the
server, storage, secrets, logs, and backups. Epicenter cannot read a deployment
it never operates.

The honest claims are:

```text
hosted       Epicenter can read synchronized data
self-hosted  the instance operator can read synchronized data
local-only   no authority receives the data
```

There is no product switch that turns the hosted service into a zero-knowledge
authority.

## Documents and blobs follow the same rule

A record may own one bounded Yjs document and one immutable blob. These are
separate physical planes because their storage and transfer needs differ, but
they do not receive different confidentiality promises.

Document updates are plaintext to the document authority. Blob bytes are raw
immutable content stored by the authority backend. The owning record address is
the blob's identity; SHA-256 verifies the published bytes and makes an exact
retry idempotent, but it does not conceal content. Hosted storage operators can
read hosted bytes. Self-hosted operators can read self-hosted bytes.

Portable Backup captures a complete authority cut, including composed
documents and every owned blob byte. Backup encryption, if introduced, is an
artifact-custody concern and does not change the live authority's trust model.

## Remote attach is a live trusted channel

Remote attach forwards Home session frames between a user's devices. The relay
stores no session history and grants no application route, but an operator may
observe prompts, tool results, approvals, identifiers, sizes, and timing while
the frames transit. Hosted attach trusts Epicenter; self-hosted attach trusts
the instance operator.

## AI and transcription services

A service sees what the application sends to it.

- Local GGUF transcription keeps audio on the desktop.
- A configured cloud transcription provider receives the audio.
- A configured language-model provider receives the prompt or transcript text
  used for that request.
- Epicenter's hosted gateways see requests in transit and forward them under
  hosted credentials. They are convenience boundaries, not privacy boundaries.

Pointing a desktop surface at a local or self-operated provider keeps that
request within the infrastructure you control. A browser may be unable to
reach a local service because of browser networking constraints; the UI must
state the actual destination rather than imply locality.

## Authentication is not content encryption

Hosted OAuth sessions and self-hosted instance bearers decide who may address
an authority. TLS protects bytes in transit. Storage-provider encryption may
protect media at rest from stolen disks. None of these prevents the running
authority or its operator from reading authorized content.

That is the complete trust model: choose who operates the authority, and treat
that operator as trusted with synchronized data.
