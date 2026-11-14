# 0864. Epicenter is a data server for repositories of files, and code runs where its owner trusts it

- **Status:** Proposed
- **Date:** 2026-11-10
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (one person's software), [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (your server), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (who commits), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the remote), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (the collection verbs, MCP), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0861](0861-whats-yours-is-everywhere-and-everything-else-is-used-where-it-is.md), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (the merge).
- **Unbuilt:** the typed client `open()`, and Whispering's clone ([ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md)). Built: each collection's `list`, `get`, `add`, `set`, `edit`, and `delete` from the command line and over MCP (`packages/app/src/collection.ts`); `epicenter serve` over HTTP, serving MCP at `/` and views at `/<app>/`, with one commit per write call and a push to `origin` every 5 minutes (`packages/cli/src/http.ts`). The public listener for an HTTPS tunnel (ADR-0871, ADR-0881) was built and then removed in 7959c24236 (ADR-0883).
- **Amended by:** [ADR-0881](0881-people-reach-an-epicenter-over-the-tailnet-and-its-public-address-serves-only-connectors.md): people reach `serve` only over the tailnet, and the public address serves only connectors. Then [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) removed the public address, its connectors, and the `connectors` block.

## Context

ADR-0863 (deleted; recoverable at `d779775119`) put one Epicenter app on every
device, each phone holding its own Git copy of every app, and ran
`epicenter.json` everywhere and `epicenter.ts` only on computers. Designing a
hosted version for other people then led to running every app's
`epicenter.ts` in the cloud: a Durable Object per repository holding its
files, a Cloudflare Dynamic Worker per call, and a context of bindings (Google
sign-ins, `fetch` to declared hosts, models) that Epicenter would hold and keep
growing. Each step followed from one premise: that Epicenter runs other people's
code. That premise brought sandboxing, custody of everyone's third-party tokens,
a file system rebuilt from Durable Objects, and a ceiling on what an app could do.

The author's own need is narrower. Their Mac Studio is always on and they reach
it by SSH and MCP; no app of theirs needs a phone offline. A personal data
server that runs no app code is a known shape: the AT Protocol's personal data
server holds a person's repository of schema-checked records, and apps are
separate programs that read and write it.

## Decision

**1. Your data is repositories of files with declared shapes.** An app is a Git
repository, `~/Epicenter/<app>/`, whose `epicenter.ts` defines its
collections (ADR-0857). A collection's files are Markdown with `key: <JSON>`
front matter. Any tool can read the files with no Epicenter running.

```txt
~/Epicenter/
  capture/      epicenter.ts  ui/  captures/<time>.md
  vocab/        epicenter.ts  ui/  words/<word>.md
  whispering/   recordings/<id>.md  recordings/<id>.local.webm
  mail/         epicenter.ts  receipts/<id>.md
```

**2. Epicenter opens repositories for any client, directly or as a server.
There is one copy, the Studio's, and clients ask it; a program whose own work
must go on offline keeps a clone and pushes to it (ADR-0887).**

| Way in | What it is | Who uses it |
| --- | --- | --- |
| `epicenter <app> <action>` | the command, opening the folder directly | you, agents with a shell |
| `open('~/Epicenter/vocab')` | the same, as a typed library | your scripts, tests |
| `epicenter serve` | MCP over HTTPS: `vocab_list`, `capture_set`, each trusted action; and each app's built `ui/` as web pages | Claude, ChatGPT, any agent; views in a browser |
| Git over HTTP | `<address>/.git/whispering`, a clone's remote, answered by `serve` | a program that keeps a clone: Whispering |

- Capture, Tasks, Vocab, agents, and views keep nothing on a device and always
  see the current files. A write through `epicenter serve` is committed,
  named for the call (`capture: add A line from Dune`), and `serve` pushes to
  the repository's GitHub mirror, which is the backup, within 5 minutes
  (ADR-0850).
- Whispering keeps a clone of its app's data repository, commits what it
  writes, pushes to its own branch when it can reach the Studio, and
  fast-forwards to what the Studio filed. The Studio merges; a clone never
  does, and `main` has one writer ([ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md), [ADR-0888](0888-the-host-merges-with-gits-line-merge-and-a-file-it-cannot-merge-takes-the-later-side-whole.md)).
- Whoever edits the Studio's files directly (Claude Code over SSH, an editor)
  commits as in any repository, or names the edits with
  `epicenter sync <app> -m`; `serve` commits what is left every 5 minutes, as
  changed outside epicenter, and pushes to the mirror (ADR-0850).
- Who may ask, clone, and push is the tailnet (ADR-0883).
- `epicenter serve` serves an app's built UI, `ui/dist/`, at `/<app>/` and MCP at `/`, one
  origin and one address for people and agents, so a view asks with no sign-in
  of its own beyond the server's. A `GET /` from a browser is the launcher. A
  view is static files with hash routes (`#/c/<id>`); the server routes
  nothing. The server's own paths start with `.`, which no app name can, so
  no app name is reserved for it; Git for a clone is at `/<app>.git` (ADR-0887).

**3. Code runs where its owner trusts it.** `epicenter serve` runs the
`epicenter.ts` of each repository its operator trusts, and offers its actions as
MCP tools. An app the operator made, alone or from another app's code with
`epicenter new --from`, is trusted: making it was the decision (ADR-0904). A server that serves people who
do not trust each other runs no one's `epicenter.ts`. A client holds its own
credentials: Mail's Google token is in `mail/google.local.md` on the machine
that runs Mail's actions (ADR-0870), and Epicenter holds only its own sign-in.

**Your Epicenter is the Studio running `epicenter serve`.** Your own devices
reach it over your tailnet. Claude.ai and ChatGPT connect from their companies'
servers, so `epicenter serve` also has one public HTTPS address, through
any HTTPS tunnel such as Tailscale Funnel, and signs a client in with OAuth, as
MCP requires: adding the connector opens a page on your tailnet where you
approve it, and the client receives a token you can revoke (ADR-0871,
ADR-0881).
Another person's Epicenter is the same program on their own computer; without a
terminal, it is the Epicenter Mac app, which runs `epicenter serve` (ADR-0865).

## Consequences

- Deleted from the plan: an Epicenter app holding a copy on every device (the
  Mac app returns as `epicenter serve` with a window, ADR-0865), Git on the phone,
  App Intents, the catalog and its install sheet, `id` in `epicenter.json`,
  the three kinds of app, models as an Epicenter setting, Epicenter
  holding third-party credentials, and running code in isolates or Durable
  Objects.
- A view is a web client: served from a repository's `ui/dist/` or from anywhere,
  it asks over MCP like an agent, and the browser sandboxes it.
- An app can start as a copy of another app's code, which holds no data; it
  holds its own code and data and is changed where it is, and no command
  merges later changes into it (ADR-0904). Since the code holds no data,
  sharing an app never shares anyone's data.
- A rule another author's app needs everywhere lives in that app's client, or in
  an `epicenter.ts` a person chooses to trust, or in that author's own MCP
  server. The server enforces shapes only.
- No app but a program's clone has Git on a device, and only the Studio
  merges (ADR-0888).
- Everything stops when the Studio is down, including after a power cut, when
  FileVault waits at its unlock screen. A client that asks has nothing offline;
  a program with a clone keeps working and pushes later.
- History has one commit per write through the server.
- `epicenter serve` answers Git for clones through stock `git http-backend`,
  behind the same door as calls (ADR-0887).
- A hosted Epicenter, serving people who do not run a computer of their own, is
  not part of this decision.

## Considered alternatives

- **A hosted runtime for every app's code: Durable Objects, Dynamic Workers, a
  context of bindings.** Epicenter would sandbox strangers' code, hold their
  tokens, and grow a binding for each service an app needs.
- **One Epicenter app holding a copy on every device (ADR-0863).**
  Git, a merge, and App Review on the phone, for offline use nobody asked for.
- **A container per person.** Its disk is gone after it sleeps, so every wake
  clones again and every write must push before answering.
- **A separate web app with its own database for each app.** Each app repeats
  accounts, storage, and MCP, and the data belongs to the app.
- **Yjs documents beside the files.** Agents cannot read them without a runtime;
  nothing here edits one text live with other people.
- **One hub per household with tokens scoped to apps.** Sharing is per
  repository, as Git hosts already do it.
- **Every client asks, Whispering included.** Whispering would hold recordings
  in an outbox until the Studio answered; its own copy and Git already do that.
- **A file watcher on the Studio committing every change.** It patched pushes
  into a folder with uncommitted files, which the `push-to-checkout` hook
  allows directly.
- **GitHub as the copies' remote, the server pulling to see what they pushed.**
  A timer or webhook before the server sees a push, and the server's copy merges
  unattended, leaving any conflict in the folder every agent reads.
- **Git over SSH to the Studio, with a `push-to-checkout` hook.** Chosen
  first. A second door with its own guard, which phones and hosted
  containers lack, and conflicts resolved on each device (ADR-0887).
- **A Cloudflare Worker in front for sign-in.** A second service for one
  person's OAuth page.
