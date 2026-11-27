# Trust model

Whoever can read your computer can read your Epicenter. Epicenter relies on
your computer for encryption at rest. `epicenter serve` signs no one in.

This page describes what the code does today, in `packages/app`
and its command, `packages/app/src/command`. [The vision](vision.md) names the pieces. The computer is one its person
controls, owned or rented.

## Your computer

Your computer is the one `~/Epicenter` is on. Its person holds root on it and
chooses the code it runs.

| Computer | Who can read your files |
| --- | --- |
| One you own, such as a Mac you keep on | You, and whatever you let in: a user account, a backup tool, an agent you give a shell. |
| One you rent, such as a Linux server from a hosting provider | You and the provider, which can read the disk and its snapshots, including `.epicenter/`. |

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

Some apps store a copy on a device for offline use. Whoever can read that
device's browser storage can read those copies. The app decides what to keep
there. [Where edits count](vision.md#where-edits-count)

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

An app can keep a sign-in, such as a Google token, under `.epicenter/` on
the computer that runs its actions. Serve keeps this folder private to your
user account and out of Git. Anyone with access to its files can read them,
including the provider of a rented computer. [Local app state](../packages/app/README.md#this-computers-state)

## Backups

Whoever hosts your Git backup can read what you push, including committed
files and their history. A separate computer backup may also include app
state and sign-ins. [What you can recover](vision.md#where-edits-count)

## Outside apps

A service such as Gmail holds its own data. An app can read or change it
through an action using your sign-in. Your local copies follow the same
access rules as the other files on your computer.

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
