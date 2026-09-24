# Trust model

Epicenter does not encrypt your data before syncing it. Whoever operates the
server holds your rows, your field values, and your prose in the clear. That one
decision is the trust model, and everything below is a consequence of it.

This page describes what the code does today. The files that carry it:

- `packages/server/src/store-sync/authority.ts`: the authority, one Durable
  Object per principal, application, and generation (ADR-0292, ADR-0298)
- `packages/server/src/store-sync/mount.ts`: the authenticated upgrade onto it
- `packages/app/src/data/store/store.ts`: the client-owned store
- `packages/app/src/data/store/browser.ts`: local persistence, in the client

The shape changed with ADR-0298, restoring ADR-0218, and is worth stating
precisely, because it moves
the trust boundary in the direction this page is about: **the authority reads
nothing it stores.** It holds opaque bytes, hands them back in order, and has no
Yjs import and no verb that could interpret one. What the server can still see
is what it is handed and when, plus everything auth needs to know about who you
are; what it no longer does is read a row.

## We used to encrypt at rest. We stopped.

For a long time Epicenter encrypted every CRDT value before it entered the synced Yjs doc. The key came from a server-held root (`ENCRYPTION_SECRETS` to an owner key to a workspace key) and shipped to the client through `/api/session`. The philosophy was "if you want full encryption, become the server."

It worked, and the tell is that it still trusted the server. The root key lived on Epicenter's infrastructure, so server code could read your data, a bug could log it, an operator could inspect it. You were never server-blind; you were trusting the application. Once you grant that, the per-owner workspace key buys nothing but a key-recovery tax and a class of "unreadable cell" failures. So we deleted it: the `@epicenter/encryption` package, the keyring, the key derivation, and the `ENCRYPTION_SECRETS` root.

The full argument is in `docs/articles/20260615T140000-dont-encrypt-the-data-dont-hold-it.md`. The design that drove the removal is `specs/20260615T120000-trusted-relay-and-collaborative-fields.md`.

## What the server sees

Nothing is encrypted before it leaves your device, so the bytes the authority
holds are your plaintext document updates. Anyone who operates the authority can
decode them with an ordinary Yjs library.

What the authority itself does is narrower, and the difference is worth being
exact about because it is easy to overstate in either direction. **The authority
reads nothing it stores** (ADR-0298). It appends opaque entries, hands them back
in order, and folds acknowledged log prefixes. Nothing
in `packages/server/src/store-sync/authority.ts` imports Yjs or a workspace, and
there is no verb there that could interpret an update. So the honest statement
is not "the server reads your rows" and not "the server cannot read your rows":
it is that the server does not read them, and could, because it holds them in
the clear.

That refusal is what a blind server would also give you, minus the
end-to-end encryption. What you give up by not encrypting is the guarantee: an
operator, a bug, or a subpoena can still reach the plaintext. What you keep is
that a future server-side feature (search, compaction, validation on the way in)
is a decision rather than a rebuild.

Content is only half of what a server learns. Sealed payloads would still leave
the routing in the clear, so the server sees the metadata around the bytes: the
authenticated principal id, the application's workspace id, and the timing,
size, and client IP of every request. That envelope outlives any future blind server,
which stops reading the values but still routes them; sealing a payload hides
what is inside it, not the fact that your phone and laptop wrote at this minute.
Run the deployment yourself and the metadata is yours. Use Epicenter's and it is
a who-writes-when graph Epicenter can read.

## The live attach relay follows the same trust model

Super Chat remote attach adds a second, live channel beside CRDT sync, but not a second privacy promise (ADR-0115).

- **The authority holds plaintext.** It decrypts nothing because nothing is encrypted, and its operator can decode what it holds. It does not read it itself (ADR-0298): serving a sleeping device's catch-up needs the bytes in order, not their meaning.
- **The live attach relay forwards plaintext live frames.** It carries a Super Chat session (prompts, tool results, approvals) between two of your own signed-in devices, addressed by `principalId`, `hostId`, `deviceId`, and `attachId`. It stores no frames and exposes no route/capability/tool surface, but hosted Epicenter may observe the live payloads while forwarding them. It is endpoint-addressed, not route-addressed, so it is not a resurrection of the deleted relay floor (ADR-0086, ADR-0115).

Confidentiality follows topology. On Cloud, the operator can read live attach frames just as it can read your synced data. On self-host the operator is you. The private answer is to run the deployment yourself.

## Big files (audio, images) follow the same rule

Rows and documents ride their own planes, but large binaries cannot, so
audio and images go to a separate immutable blob store: an S3-compatible bucket
reached through `packages/server/src/s3-blob-store.ts`. Those bytes are **not
encrypted** either. Each object has a random opaque `BlobId`; SigV4 signs the
short-lived upload or read capability, and `If-None-Match: *` prevents an
existing ID from being overwritten. Reads are gated by auth plus a principal
key prefix (`principals/<principalId>/blobs/<blobId>`), not by concealing the
bytes. A blob's confidentiality therefore equals a document's: whoever operates
the bucket can read it. Hosted, that operator is Epicenter (R2); self-hosted, it
is your own bucket (Garage, S3). R2 and S3 encryption at rest does not change
who can read through the operator's credentials.

One configuration is easy to get wrong here. The blob store is a service the server calls, not a part of the sync topology, so the bytes follow the store's endpoint, not the document's home. A blob's upload URL is minted by whichever deployment you are talking to, and the bytes land in that deployment's bucket. Self-host the documents but point blobs at Epicenter's blob service, and your media lands in Epicenter's R2, readable by Epicenter, the same trust as hosted documents, even though the document itself never left your box. To keep media private on self-host, point the store at your own S3 (`BLOBS_S3_ENDPOINT`). A service only ever sees what you hand it; for the blob service, what you hand it is the bytes.

## The AI gateways see the prompt and the audio

The same "a service sees only what you hand it" rule governs inference. Epicenter's hosted gateways are two OpenAI-compatible routes on the cloud worker: `/v1/chat/completions` for chat (`packages/server/src/routes/inference.ts`) and `/v1/audio/transcriptions` for speech-to-text (`packages/server/src/routes/transcription.ts`). Both are pure passthrough proxies. The gateway holds the house key, attaches it, forwards your request to the upstream provider (OpenAI or Gemini for chat, OpenAI `whisper-1` for transcription), and streams the reply back. It is house-key-only by construction: it never reads a provider key from your request, so it cannot receive yours (ADR-0054).

What that means for your bytes: when you transcribe through the hosted gateway, your audio leaves your device, reaches Epicenter's worker in memory for the duration of the one request, and is forwarded to the upstream STT provider under Epicenter's key. The worker writes nothing to the blob store, keeps no transcript, and retains nothing past the response; the only durable record is a metered usage event (audio seconds, model, provider) so the call can be billed. The audio is never used for training, by us or, per their API terms, by the upstream provider. The same holds for a chat prompt: it transits the worker to the provider and back, unstored. This is convenience, not privacy: the request is inside Epicenter's trust boundary and the upstream provider's for the moment it is in flight, exactly the trust you already accept for hosted chat.

The private path is the same shape as everywhere else: point the connection somewhere you operate. An inference connection is just `{ baseUrl, apiKey? }` (ADR-0060), so a surface can target a local server, your own Ollama for chat or a local Speaches box for transcription, and the bytes never leave your machine (see the [self-hosted transcription recipe](guides/self-hosted-transcription-speaches.md)). There is one runtime now, a desktop SPA in a WebView (ADR-0227), and it can reach `localhost`, so private is the reachable default rather than a thing the deployment target takes away. The hosted gateway stays there for convenience, inside our trust boundary.

## Two deployments, decided by who holds the data

Epicenter Cloud, the default, is operated by Epicenter, so hosted data sits inside our trust boundary. It is the same promise as before, without the key-derivation machinery around it. `BETTER_AUTH_SECRET` signs auth cookies, tokens, and OAuth state in `packages/server/src/auth/create-auth.ts`; it is not a data encryption root, and it is Cloud-only. Better Auth is a Cloud-only layer (ADR-0076), so a self-hosted instance composes no Better Auth and has no `BETTER_AUTH_SECRET` at all.

Self-hosting is functionally zero-knowledge against Epicenter, because Epicenter never holds or sees the data: you operate the deployment. The strength comes from topology, not from a held secret. So the marketing has to stay honest about which deployment it describes. "We cannot read your data" is true when you self-host, not on the default.

## Logging in: Google for hosted, one bearer for an instance

Hosted Epicenter signs in with social OAuth: `packages/server/src/auth/base-config.ts` disables email/password on purpose, because better-auth 1.5.6 has no local-email-verification gate and no mail sender is wired up, so a local account would open an account-takeover path. OAuth is hosted-only (ADR-0071).

A self-hosted instance does not use OAuth at all, so there is no Google app to register for your own box. It authenticates with one operator-supplied static bearer (`INSTANCE_TOKEN`): you generate it once (`bun run gen-token`), supply it through the environment, and paste it into the client; every request is constant-time compared against it and resolves the one `principals/instance` partition. No sign-in flow, no first-boot minting, no mode to pick. That is `docs/adr/0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md`, amended by ADR-0092, which supersedes ADR-0070 and an earlier first-boot-minting direction that never became a published ADR. The cost, named honestly: removing one person from a multi-person instance means rotating the token and redistributing it, because per-person revocation is a deliberately unbuilt seam rather than a shipped feature.

Because the instance has no OAuth and no sessions, it composes no Better Auth and no Postgres at all (ADR-0076): the bearer is constant-time compared in-process, and there is nothing for the operator to provision but the token. Neither entry point constructs a database (ADR-0226, ADR-0227), which is what lets the same instance run as a single Bun binary or a Cloudflare Worker. Store sync itself is not mounted on an instance today; only the hosted Worker resolves a store authority.

## Where this is heading: the anchor

Privacy stops being an encryption layer and becomes a topology choice. The direction, validated in a throwaway local spike but not product code yet, is Iroh: every device gets a public-key identity and opens a direct, end-to-end-encrypted QUIC connection addressed by that key. When two devices cannot connect directly, a relay forwards the sealed frames it cannot decode.

The one place a server still has to be an endpoint is when your phone edits and your laptop is asleep: something always-on has to hold that update until the laptop wakes. That something is the anchor, and the anchor decrypts and stores. So "do we encrypt the data" becomes "who runs the anchor":

- Bring your own anchor, and nobody else ever holds your data. This is the privacy choice, stronger than the encrypted key-value ever was, with zero encryption code.
- Trust Epicenter's anchor, the default, and we hold your data, the same promise as today.

"Become the server" shrinks to "become the anchor": one always-on node instead of a whole auth-and-sync stack. The browser stays a relay-bound leaf (WASM, no UDP hole-punching), and the relay still cannot read the frames. Client-encrypted backup snapshots are the one place a sealed blob still earns its keep, and that primitive returns, minimal, when backup is built.

The local spike proved the shape worth keeping: a Mac Studio home anchor persisted a CRDT doc reached from a MacBook on phone hotspot; a JS/Yjs runtime then used a Rust/Iroh sidecar to stream live updates into that anchor and hydrate them back. That does not solve pairing, auth, packaging, browser access, or serving more than one document. It does prove the important boundary: TypeScript can keep owning Yjs/app semantics while Rust only owns native reachability.

## Migration

There is no deployed encrypted data to protect, so the migration is a one-off manual step: clear local devices once. No client storage name bump or in-script corruption guard is needed.
