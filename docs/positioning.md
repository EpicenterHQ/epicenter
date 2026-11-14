# Positioning

Canonical positioning for Epicenter. This doc owns the public claims and the
rules for deriving copy from them. Finished copy belongs to the surface that
ships it: README, landing page, GitHub About, package metadata, or launch plan.

Every claim here describes what the code does today. A decided but unbuilt
feature stays out of public copy until it ships; check the ADR's Unbuilt line.
[The vision](vision.md) states the direction these claims come from.

## The spine

One message, cut to length and audience. No cut contradicts a shorter one, and
every claim from a shorter cut survives in the longer cuts.

One line, for one-line surfaces (GitHub About, social preview, link cards):

> Where one person's software lives.

The hero cut, for the root README:

> **Where one person's software lives.** Small apps keep what you make as
> plain files on one computer you control, and every device you own, and your
> agents, reach them there.

The public cut, for epicenter.so and other general-audience surfaces:

> Apps come and go. Your files shouldn't. Epicenter apps save everything you
> make as ordinary files in a folder on your computer, so what matters to you
> outlives every app that made it.

The public cut predates the spine and still reads true, but it does not yet
carry "every device you own, and your agents". The landing page owns its copy;
change the two together.

On public surfaces the mechanism (Markdown, Git, MCP, a tailnet) appears below
the fold, after the benefit it guarantees, never as the headline.

## The proof line

Every shipped surface longer than one line carries exactly one proof line,
stated without caveats. Each surface writes its own sentence, and that
sentence carries:

- Whispering, by name
- desktop speech-to-text
- you can install it today
- macOS, Windows, and Linux, somewhere on the surface (platform badges or
  adjacent copy count)

Whispering is an outside app: it works without an Epicenter. The proof line
says the company ships, not that Whispering runs on a home.

Roadmap language stays out of heroes.

## What Epicenter is

- A folder on the home, `~/Epicenter`, holding a folder per app in `apps/`
  ([ADR-0868](adr/0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md),
  [ADR-0885](adr/0885-an-epicenters-apps-live-in-apps-which-its-repository-ignores-with-one-line.md)).
  The home is a computer its person controls, owned or rented
  ([ADR-0903](adr/0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md)).
- An app is one `epicenter.ts` declaring its collections and actions, an
  optional UI, and a `data/` folder of Markdown files; its code and its data
  are two Git repositories
  ([ADR-0857](adr/0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md),
  [ADR-0877](adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).
- A command, `epicenter`, that runs an app's actions and commits what each
  writes, and `epicenter serve`, which offers every app's actions over MCP and
  each app's UI in a browser to the person's devices and agents
  ([ADR-0850](adr/0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md),
  [ADR-0860](adr/0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md)).

## What Epicenter is not

- Not a hosted product: your Epicenter runs on your home. What the company
  hosts, such as sign-in and paid models in `apps/api`, is a service, an
  outside app like Gmail
  ([ADR-0901](adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md)).
- Not sync: the person's other devices keep no copy and reach the one on the
  home. Epicenter never reconciles two writable copies
  ([ADR-0896](adr/0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md)).
- Not a sandbox: `serve` runs every app's code in its one process, with no
  sandbox, and signs no one in; who reaches it is the tailnet's decision
  ([ADR-0883](adr/0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md)).
- Not encrypted: whoever can read the home's disk can read the files, and a
  rented home's provider can. See the [trust model](trust-model.md).

## Verifiable claims

Every public claim must be provable by inspecting the repository:

| Claim | Proof |
| --- | --- |
| "We ship" | Whispering installs on macOS, Windows, and Linux through normal release channels. |
| "Plain files" | A collection's records are Markdown files under the app's `data/`, at the path its template names (`packages/app/src/collection.ts`), and every write lands in that folder's Git history (`packages/cli/src/snapshot.ts`). |
| "On one computer you control" | A command runs on the computer it is typed on, and `serve` listens on `127.0.0.1` unless told otherwise (`packages/cli/src/http.ts`). Nothing in this repository runs a person's Epicenter for them (ADR-0903). |
| "Every device you own, and your agents, reach them" | `serve` answers MCP at `/` and each app's UI at `/<app>/` (`packages/cli/src/http.ts`, `mcp.ts`); a reverse proxy such as `tailscale serve` puts it on the tailnet. |
| "Any tool can edit them" | A change made outside an action is committed as "changed outside epicenter" (`packages/cli/src/snapshot.ts`). |
| "Bring your own model" | AI features accept user-provided API keys. |

Not yet true, so not yet in public copy: installing `epicenter` from npm
(ADR-0892), Epicenter for Mac (ADR-0865), and a job that keeps `serve` running
on Linux (ADR-0878).

## Vocabulary

Use the word a person already has on public surfaces: app, file, folder, your
computer. Developer docs use the vision's words: the home, an inside app, an
outside app, a program, a service ([vision](vision.md), "The pieces").

- "Server" means someone else's computer, and "hosted" means someone else runs
  it. A person's own computer is the home, never their server.
- "Local-first" is only for a product whose devices sync. Epicenter's devices
  do not, so it is not local-first.
- Do not say Epicenter syncs, or name a hosted, cloud, or self-hosted
  Epicenter. The folder sync product that did is retired
  ([ADR-0899](adr/0899-the-folder-sync-product-is-retired.md)).

Do not use hype words: `AI-native`, `agentic`, `next-gen`, `revolutionary`,
`redefine`, `game changer`, `Web3`, `metaverse`. Do not describe Epicenter's
data as CRDT-backed or conflict-free.

## Package copy

Each package's npm description and keywords live in its `package.json`; that
file is the owner. A description leads with what the package does, not what
category it is in.
