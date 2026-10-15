# Trust model

Epicenter does not encrypt your data before syncing it. Whoever operates the
server your data syncs with holds your files in the clear. That one decision is
the trust model, and everything below is a consequence of it.

This page describes what the code does today. A data folder is a directory of
Markdown and JSON files with Git history beside them, and every device you use
keeps the whole folder (ADR-0532). It syncs over plain Git, with a token, to the
remote in its own `remote.origin.url` (ADR-0521). The files that carry it:

- `packages/folder/src/git/`: history, and the transport that pushes and fetches
- `packages/server/src/routes/git.ts`: the hosted Git module, Git smart HTTP
  with a token for one repository
- `apps/api/worker/git-repositories.ts`: where Epicenter's hosted Git keeps
  repositories, in Cloudflare Artifacts
- `packages/server/src/s3-blob-store.ts`: hosted blobs

The Yjs store sync that came before this, an authority that held each document's
updates as opaque bytes, is removed, and the next deploy deletes what it stored
(ADR-0534).

## We used to encrypt at rest. We stopped.

For a long time Epicenter encrypted every CRDT value before it entered the synced Yjs doc. The key came from a server-held root (`ENCRYPTION_SECRETS` to an owner key to a workspace key) and shipped to the client through `/api/session`. The philosophy was "if you want full encryption, become the server."

It worked, and the tell is that it still trusted the server. The root key lived on Epicenter's infrastructure, so server code could read your data, a bug could log it, an operator could inspect it. You were never server-blind; you were trusting the application. Once you grant that, the per-owner workspace key buys nothing but a key-recovery tax and a class of "unreadable cell" failures. So we deleted it: the `@epicenter/encryption` package, the keyring, the key derivation, and the `ENCRYPTION_SECRETS` root.

<!-- doc-path-check: ignore-next-line -->
The full argument is in `docs/articles/20260615T140000-dont-encrypt-the-data-dont-hold-it.md`. The design that drove the removal is `specs/20260615T120000-trusted-relay-and-collaborative-fields.md`.

## What the server sees

Nothing is encrypted before it leaves your device, so the server your folder
syncs with holds your files as files: readable Markdown and JSON, with their
whole Git history. Whoever operates that server can read them with `git clone`.

Who that is depends on the remote you choose:

| Remote | Who can read your files |
| --- | --- |
| A Git server you run | you, and anyone who reaches your box |
| Epicenter's hosted Git | Epicenter's operators, and Cloudflare, which stores it |
| GitHub, GitLab, any other host | that host's operators |

Epicenter's hosted Git passes every byte through Epicenter's Worker to
Cloudflare Artifacts, which stores each folder as a repository. The token
`/api/git/connect` returns reaches that one repository, for writing, and
expires after an hour. Epicenter runs no relay to GitHub or any other host: a
desktop app talks to such a remote directly with your own Git credentials, and
Epicenter sees nothing.

Content is only half of what a server learns. The server also sees the metadata
around the bytes: who pushed, to which repository, when, how much, and from which
IP. Run the server yourself and that metadata is yours too.

## Big files (audio, images) follow the same rule

Rows and documents ride Git, but large binaries do not belong in history, so
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

Epicenter Cloud, the default, is operated by Epicenter, so hosted data sits inside our trust boundary. It is the same promise as before, without the key-derivation machinery around it. `BETTER_AUTH_SECRET` signs auth cookies, tokens, and OAuth state in `packages/server/src/auth/create-auth.ts`; it is not a data encryption root. A self-hosted server runs the same Better Auth on Bun with Postgres (`apps/api/server.ts`) under its own `BETTER_AUTH_SECRET`.

Self-hosting is functionally zero-knowledge against Epicenter, because Epicenter never holds or sees the data: you operate the deployment. The strength comes from topology, not from a held secret. So the marketing has to stay honest about which deployment it describes. "We cannot read your data" is true when you self-host, not on the default.

## Logging in: social OAuth on every deployment

Epicenter signs in with social OAuth: `packages/server/src/auth/base-config.ts` disables email/password on purpose, because better-auth 1.5.6 has no local-email-verification gate and no mail sender is wired up, so a local account would open an account-takeover path.

A self-hosted server signs in the same way, so its operator registers their own OAuth apps (Google, GitHub, Microsoft) for their own origin. ADR-0549 records the planned move to one OAuth 2.1 authorization server per deployment.

Because the instance has no OAuth and no sessions, it composes no Better Auth and no Postgres at all (ADR-0076): the bearer is constant-time compared in-process, and there is nothing for the operator to provision but the token. Neither entry point constructs a database (ADR-0226, ADR-0227), which is what lets the same instance run as a single Bun binary or a Cloudflare Worker.

## Where this is heading

Privacy is a choice of remote, not an encryption layer. A folder's remote can be
any Git server, so "who can read my data" is answered by "whose server is in
`remote.origin.url`". Epicenter ships the apps; you choose who holds the synced
copy, and every device keeps the full folder either way (ADR-0521). The private
answer is to run the Git server yourself; the convenient one is to let
Epicenter run it.

## Migration

There is no deployed encrypted data to protect, so the migration is a one-off manual step: clear local devices once. No client storage name bump or in-script corruption guard is needed.
