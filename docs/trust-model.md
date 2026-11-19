# Trust model

Your Epicenter is on your computer, and whoever can read your computer can read it.
Nothing is encrypted, nothing syncs, and `epicenter serve` signs no one in.
That is the trust model, and everything below follows from it.

This page describes what the code does today, in `packages/app`
and its command, `packages/app/src/command`. [The vision](vision.md) names the pieces. The computer is one its person
controls, owned or rented.

## Your computer

Your computer is the one `~/Epicenter` is on. Its person holds root on it, and
it runs only the code they trust. An app's records are Markdown files under
its `data/`, in a Git repository on your computer, and nothing in Epicenter
encrypts them.

| Computer | Who can read your files |
| --- | --- |
| One you own, such as a Mac you keep on | You, and whatever you let in: a user account, a backup tool, an agent you give a shell. |
| One you rent, such as a Linux server from a hosting provider | You and the provider, which can read the disk and its snapshots, your Epicenter's `local/` folder included. Epicenter adds nothing against that. |

Choosing where to rent a computer is choosing who can read it, in the way choosing
which agents get a shell is.

## Reaching your Epicenter

`epicenter serve` offers every app's actions over MCP and HTTP. It signs no
one in: anything that reaches it can call every action of every app, so who
reaches it is your decision. It listens only on `127.0.0.1`. Another
device reaches it through a private proxy on this computer, such as
`tailscale serve`, which also adds HTTPS. Serve refuses DNS rebinding,
requests from other sites in a browser, and the tunnels it can recognize
([serve's guards](../packages/app/README.md#the-command-and-serve)), but a
tunnel it cannot recognize would reach it with no sign-in, so never tunnel
its port.

Your other devices keep nothing. An agent on your phone or your laptop sees
the files only while it reaches your computer, through actions.

`serve` also sends the Epicenter's `AGENTS.md` to every MCP client as its
instructions, so anything written there reaches each agent that connects.

## The code you run

`serve` imports your Epicenter's root `epicenter.ts`, and with it the code of every
app it composes, with your privileges, in one process, with no sandbox. The
`epicenter` command runs no app code: it sends each call to `serve`.
An action can read any file you can, and the data handles it is given are a
convenience, not a boundary. An app you copy into your Epicenter's `apps/` runs
its author's code. The copy has no upstream or automatic merge. Inspect
incoming code before copying later changes. Trust it as you would any
program you install.

## Sign-ins are files that stay on your computer

An app keeps a sign-in, such as a Google token, in a file it writes under your
Epicenter's root `local/`, which stays out of Git
([the Epicenter's rules](../packages/app/README.md#the-home)); list `/local/` in
the root `.gitignore` too, for an app that makes the folder itself.
Epicenter never commits, so a file there reaches a backup or a clone only if
someone adds it by force. It is a plain file, though: anyone who can read your
computer can read it, the provider of a rented computer included.

## Backups

Your Epicenter has one private root Git repository holding its `epicenter.ts`,
every app's code in `apps/`, and the records in `data/`. Its `origin` is an
optional push-only backup. Agents edit the working files; the commits you
make record them. No command publishes or copies an app out; sharing one is
copying its `apps/<app>/` folder with ordinary tools, which carries none of
the records. Nothing is pushed until you add one. Whoever hosts that repository, GitHub or
your own Git server, can read what is pushed: every committed file and its
history, never a file under `local/`.

## Outside apps

A service such as Gmail already holds its own data. An inside app brings it to
your Epicenter only by a pull, which copies items inward and never writes the
source. The author's Mail app, which is not in this repository, keeps its
mailbox as a SQLite cache under your Epicenter's `local/`. A change to the service
is an action you run, such as Mail's `epicenter mail apply`, which changes
Gmail through your own sign-in.

## A model sees what you send it

An inference connection is `{ baseUrl, apiKey? }`
(`packages/ai/src/custom-endpoints.ts`). Whispering sends
your prompt or audio to the endpoint you configure: a provider you hold a key
for, or a server you run, such as Ollama for chat or a local Speaches server for
transcription. With a local server the bytes never leave your machine.
Epicenter runs no inference gateway of its own.

## What came before

The folder sync product kept every device's folder in step through an
Epicenter server, hosted or self-hosted, that held each folder's history in
plaintext. It is retired, and so is its
trust model: a choice of server and of who a folder was shared with. Its server
code was deleted with the hosted API.

Before that, Epicenter encrypted every value in a synced Yjs document under a
key derived from a root its servers held. That still trusted the server, so it
was deleted with the `@epicenter/encryption` package.
