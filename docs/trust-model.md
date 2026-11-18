# Trust model

Your Epicenter is on the home, and whoever can read the home can read it.
Nothing is encrypted, nothing syncs, and `epicenter serve` signs no one in.
That is the trust model, and everything below follows from it.

This page describes what the code does today, in `packages/cli` and
`packages/app`. [The vision](vision.md) names the pieces, and
[ADR-0903](adr/0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md)
decides that the home is a computer its person controls, owned or rented.

## The home

The home is the computer `~/Epicenter` is on. Its person holds root on it, and
it runs only the code they trust. An app's records are Markdown files under
its `data/`, in a Git repository on the home, and nothing in Epicenter
encrypts them.

| Home | Who can read your files |
| --- | --- |
| One you own, such as a Mac you keep on | You, and whatever you let in: a user account, a backup tool, an agent you give a shell. |
| One you rent, such as a Linux server from a hosting provider | You and the provider, which can read the disk and its snapshots, `.local` files included. Epicenter adds nothing against that. |

Choosing where to rent a home is choosing who can read it, in the way choosing
which agents get a shell is. Epicenter's hosted services hold no part of your
Epicenter and none of its sign-ins.

## Reaching the home

`epicenter serve` offers every app's actions over MCP at `/`, and each app's
UI at `/<app>/` (`packages/cli/src/http.ts`). It signs no one in: it trusts
this computer and the tailnet, and who reaches it is the home's decision
([ADR-0883](adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)).
Anything that reaches it can call every action of every app.

- It listens only on `127.0.0.1`, and it has no flag to listen anywhere else.
  Another device reaches it through a private proxy on this computer, such as
  `tailscale serve`, which also adds HTTPS
  ([ADR-0927](adr/0927-serve-listens-only-on-this-computer.md)).
- It answers only a `Host` that is `localhost`, an IP address, or a `*.ts.net`
  name, so a DNS rebinding name gets 403, and an `Origin`, when sent, must
  match the `Host`.
- It refuses, with 403, any request carrying the header a Tailscale Funnel or
  Cloudflare Tunnel adds. Another tunnel that adds no such header would reach
  `serve` with no sign-in, so never tunnel its port.

Your other devices keep nothing. A UI on your phone, or an agent on your
laptop, sees the files only while it reaches the home, through actions.

`serve` also sends the Epicenter's `AGENTS.md` to every MCP client as its
instructions, so anything written there reaches each agent that connects.

## The code you run

`serve` and `epicenter` run each app's `code/epicenter.ts` with your privileges,
in one process, with no sandbox
([ADR-0880](adr/0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md)).
An action can read any file you can, and `folder` is a convenience, not a
boundary. An app you copy into your home runs its author's code. The copy
has no upstream or automatic merge. Inspect incoming code before copying later changes. Trust it as you
would any program you install.

## Sign-ins are files that stay on the home

An app keeps a sign-in, such as Mail's Google token, in a `.local` file in its
own folder ([ADR-0870](adr/0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md)).
The home's `.gitignore` keeps each app's `local/` folder, and files named
`*.local` or `*.local.*`, out of every commit. That file is the only guard:
Epicenter has no command that commits (ADR-0940). A new file written under
`local/` through `folder` is `0600`. So a local file reaches a backup or a clone
only if that ignore line is removed or the file is added by force. It is a plain
file, though: anyone who can read the home can read it, the provider of a
rented home included.

## Backups

The home has one private root Git repository holding every app's code and
included records. Its `origin` is an optional push-only backup
([ADR-0910](adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)).
Agents edit the working files; named or periodic checkpoints record pending
changes. Publishing an app copies only its code into a separate history.
Nothing is pushed until you add one. Whoever hosts that repository, GitHub or
your own Git server, can read what is pushed: every committed file and its
history, never a `.local` file.

## Outside apps

A service such as Gmail already holds its own data. An inside app brings it to
the home only by a pull, which copies items inward and never writes the
source; Mail keeps its mailbox as a `.local` SQLite cache on the home. A change
to the service is an action you run, such as `epicenter mail apply`, which
changes Gmail through your own sign-in
([ADR-0882](adr/0882-mail-leaves-mail-in-gmail-and-agents-change-it-through-proposals-the-person-applies.md),
[ADR-0898](adr/0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md)).

Epicenter's own hosted services (`apps/api`) are outside apps in the same
sense. They hold your account and what you send them. They hold no part of
your Epicenter.

## The AI gateways see the prompt and the audio

Epicenter's hosted gateways are two OpenAI-compatible routes in `apps/api`:
`/v1/chat/completions` for chat (`packages/server/src/routes/inference.ts`) and
`/v1/audio/transcriptions` for speech-to-text
(`packages/server/src/routes/transcription.ts`). Both are passthrough proxies.
The gateway attaches Epicenter's own key, forwards your request to the upstream
provider (OpenAI or Gemini for chat, OpenAI `whisper-1` for transcription), and
streams the reply back. It never reads a provider key from your request, so it
cannot receive yours (ADR-0054).

When you transcribe through the hosted gateway, your audio leaves your device,
reaches Epicenter's Worker in memory for the one request, and goes to the
upstream provider under Epicenter's key. The Worker keeps no audio and no
transcript; the only durable record is a metered usage event (audio seconds,
model, provider) so the call can be billed. A chat prompt is handled the same
way. For that moment the request is inside Epicenter's trust boundary and the
provider's.

The private path is to point the connection somewhere you operate. An
inference connection is `{ baseUrl, apiKey? }` (ADR-0060), so Whispering can
use your own Ollama for chat or a local Speaches server for transcription, and
the bytes never leave your machine.

Epicenter signs in with social OAuth only: `packages/server/src/auth/base-config.ts`
disables email and password on purpose, since no mail sender is wired up to
verify an address.

## What came before

The folder sync product kept every device's folder in step through an
Epicenter server, hosted or self-hosted, that held each folder's history in
plaintext. It is retired
([ADR-0899](adr/0899-the-folder-sync-product-is-retired.md)), and so is its
trust model: a choice of server and of who a folder was shared with. Its routes
still exist in `packages/server` until nothing imports them.

Before that, Epicenter encrypted every value in a synced Yjs document under a
key derived from a root its servers held. That still trusted the server, so it
was deleted with the `@epicenter/encryption` package.
<!-- doc-path-check: ignore-next-line -->
The argument is in `docs/articles/20260615T140000-dont-encrypt-the-data-dont-hold-it.md`.
