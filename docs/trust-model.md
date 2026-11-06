# Trust model

Epicenter does not encrypt your data before syncing it. Whoever operates the
server your data syncs with holds your files in the clear. That one decision is
the trust model, and everything below is a consequence of it.

This page describes what the code does today. A folder is a directory of
Markdown and other files, and every device you use keeps the whole folder as
plain files, with no Git on the computer
([ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)).
It syncs only with an Epicenter server, hosted or self-hosted, with an access
token ([ADR-0803](adr/0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md)).
The server keeps each folder's history as a log of versions at
`/folders/<id>`, in Postgres, with its larger bytes in a blob store
([ADR-0824](adr/0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md)).
The files that carry it:

- `packages/folder/src/sync/` and `packages/folder/src/remote/`: the sync
  function, and the requests it makes of a folder on the server
- `packages/server/src/routes/folder.ts` and `routes/folders.ts`: a folder's
  routes, with a token for one folder, and `packages/server/src/log/`: its log
- `apps/api/worker/index.ts`: where Epicenter's hosted server keeps bytes, in
  Cloudflare R2

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
whole history. Whoever operates that server can read them, in its database and
its blob store.

Who that is depends on the server you choose:

| Server | Who can read your files |
| --- | --- |
| A self-hosted Epicenter server (`apps/api/server.ts`, Bun with Postgres) | you, and anyone who reaches your box |
| Epicenter's hosted server | Epicenter's operators, and the providers that store it: Cloudflare (R2) and the Postgres host |

A folder does not sync with GitHub, GitLab, or another Git host: a client syncs
only with an Epicenter server. Its files come to any computer with
`epicenter clone`, and its history leaves as a Git repository with
`epicenter export --git`
([ADR-0803](adr/0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md),
[ADR-0826](adr/0826-history-enters-and-leaves-epicenter-as-git.md)).

A folder's readers are its members, and each member is an owner, a writer, or a
reader. A share is an invitation to an email that waits until that person accepts
it, and the server answers it the same whether or not the email has an account
([ADR-0820](adr/0820-a-share-is-an-invitation-to-an-email-and-reaching-every-folder-is-a-permission.md)).
Removing a member refuses their next sync; it does not recall the files they
already hold. A token reaches the folders attached to its app, or every folder
its person holds when it carries `folders:all`, which the CLI and the Epicenter
app ask for.

Epicenter's hosted server passes every byte through Epicenter's Worker, which
checks your access token, your membership in the folder, and the token's reach
on every request, then reads or writes the folder's log in Postgres and its
larger bytes in R2 with the Worker's own bindings; your token reaches neither.

Content is only half of what a server learns. The server also sees the metadata
around the bytes: who wrote, to which folder, when, how much, and from which
IP. Each change records its author's name and email and the program that made
it. Run the server yourself and that metadata is yours too.

## Recordings and other attachments sync with the folder

Every visible file in a folder syncs, a hidden path does not
([ADR-0804](adr/0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md)).
A recording's audio is a file beside its note, so it goes to the server with
the folder and is as readable there as a note. The server keeps a file's bytes
by their SHA-256: up to 16 KiB in Postgres, and larger ones in R2 on the hosted
cloud or on disk on a self-hosted Bun server, at `folders/<id>/blobs/<sha256>`
([ADR-0824](adr/0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md)).
The bytes are never shared between folders, so one folder cannot learn whether
a file exists in another. Purging a version deletes its bytes; the log keeps
its name and size.

A setting that keeps audio on the computer that recorded it, or does not keep it
at all, is decided and not built
([ADR-0788](adr/0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md)).
Until then, audio in a synced folder leaves the computer, to the server and to
every member's computer.

## The AI gateways see the prompt and the audio

The same "a service sees only what you hand it" rule governs inference. Epicenter's hosted gateways are two OpenAI-compatible routes on the cloud worker: `/v1/chat/completions` for chat (`packages/server/src/routes/inference.ts`) and `/v1/audio/transcriptions` for speech-to-text (`packages/server/src/routes/transcription.ts`). Both are pure passthrough proxies. The gateway holds the house key, attaches it, forwards your request to the upstream provider (OpenAI or Gemini for chat, OpenAI `whisper-1` for transcription), and streams the reply back. It is house-key-only by construction: it never reads a provider key from your request, so it cannot receive yours (ADR-0054).

What that means for your bytes: when you transcribe through the hosted gateway, your audio leaves your device, reaches Epicenter's worker in memory for the duration of the one request, and is forwarded to the upstream STT provider under Epicenter's key. The worker stores nothing, keeps no transcript, and retains nothing past the response; the only durable record is a metered usage event (audio seconds, model, provider) so the call can be billed. The audio is never used for training, by us or, per their API terms, by the upstream provider. The same holds for a chat prompt: it transits the worker to the provider and back, unstored. This is convenience, not privacy: the request is inside Epicenter's trust boundary and the upstream provider's for the moment it is in flight, exactly the trust you already accept for hosted chat.

The private path is the same shape as everywhere else: point the connection somewhere you operate. An inference connection is just `{ baseUrl, apiKey? }` (ADR-0060), so a surface can target a local server, your own Ollama for chat or a local Speaches box for transcription, and the bytes never leave your machine. There is one runtime now, a desktop SPA in a WebView (ADR-0227), and it can reach `localhost`, so private is the reachable default rather than a thing the deployment target takes away. The hosted gateway stays there for convenience, inside our trust boundary.

## Two deployments, decided by who holds the data

Epicenter Cloud, the default, is operated by Epicenter, so hosted data sits inside our trust boundary. It is the same promise as before, without the key-derivation machinery around it. `BETTER_AUTH_SECRET` signs auth cookies, tokens, and OAuth state in `packages/server/src/auth/create-auth.ts`; it is not a data encryption root. A self-hosted server runs the same Better Auth on Bun with Postgres (`apps/api/server.ts`) under its own `BETTER_AUTH_SECRET`.

Self-hosting is functionally zero-knowledge against Epicenter, because Epicenter never holds or sees the data: you operate the deployment. The strength comes from topology, not from a held secret. So the marketing has to stay honest about which deployment it describes. "We cannot read your data" is true when you self-host, not on the default.

## Logging in: social OAuth on every deployment

Epicenter signs in with social OAuth: `packages/server/src/auth/base-config.ts` disables email/password on purpose, because better-auth 1.5.6 has no local-email-verification gate and no mail sender is wired up, so a local account would open an account-takeover path.

A self-hosted server signs in the same way, so its operator registers their own OAuth apps (Google, GitHub, Microsoft) for their own origin. ADR-0549 records the planned move to one OAuth 2.1 authorization server per deployment.

Because the instance has no OAuth and no sessions, it composes no Better Auth and no Postgres at all (ADR-0076): the bearer is constant-time compared in-process, and there is nothing for the operator to provision but the token. Neither entry point constructs a database (ADR-0226, ADR-0227), which is what lets the same instance run as a single Bun binary or a Cloudflare Worker.

## Where this is heading

Privacy is a choice of server, not an encryption layer. A folder syncs with one
Epicenter server, so "who can read my data" is answered by "whose server this
computer syncs with" and who its members are. Epicenter ships the apps and the
server; you choose who holds the synced copy, and every device keeps the full
folder either way. The private answer is to run the server yourself; the
convenient one is to let Epicenter run it.

## Migration

There is no deployed encrypted data to protect, so the migration is a one-off manual step: clear local devices once. No client storage name bump or in-script corruption guard is needed.
