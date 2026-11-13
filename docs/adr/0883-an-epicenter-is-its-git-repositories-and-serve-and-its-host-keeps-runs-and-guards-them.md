# 0883. An Epicenter is its Git repositories and `serve`, and its host keeps, runs, and guards them

- **Status:** Accepted
- **Date:** 2026-11-12
- **Supersedes:** [ADR-0881](0881-people-reach-an-epicenter-over-the-tailnet-and-its-public-address-serves-only-connectors.md) and [ADR-0871](0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md): `serve` has no public address, no authorization server, and no `connectors` block, and `epicenter connectors` is gone.
- **Amended by:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md): a client proposes a change by a call or by pushing a clone's branch of an app's data repository, and the host's filing of that push is a write like an action's run.
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (one person's software), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (the clock), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (one home, a push-only backup), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (`serve` trusts the tailnet), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`.local` files), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (code and data repositories), [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) (the macOS job), [ADR-0882](0882-mail-leaves-mail-in-gmail-and-agents-change-it-through-proposals-the-person-applies.md) (Mail's Google token).

## Context

ADR-0881 left `serve` with two listeners: one for this computer and the
tailnet, and one at a public address where claude.ai and ChatGPT connectors
signed in with OAuth, approved on a page only the tailnet reaches. Its owner
reaches every app over the tailnet and drives Claude Code on the server from
a phone, and does not use the connectors. That public listener was about 2,700
lines of code and tests, and its only callers were the connectors.

Asking whether the public address should stay raised a wider question: what is
an Epicenter, and what belongs to the computer it runs on? The question was
tested against a hosted Epicenter, one container per person that sleeps when
idle, as a direction rather than a product (research on Zo Computer, Fly
Machines, Cloudflare Containers and Turso, 2026-11-12). A design that is right
for one person's server and for a sleeping container is unlikely to be
overfitted to either.

The public address failed that test. Its approval page needs a tailnet, which a
hosted container does not have; a hosting service would put one sign-in in
front of every person's container, as Zo puts one in front of every computer,
not a copy inside each `serve`. So the public listener belonged to neither: it
did, for one host, a job the host already did.

## Decision

**An Epicenter is the folder, whose truth is in Git, and `serve`, which answers
calls on it. A host keeps the folder, runs `serve`, and decides who reaches
it.**

```txt
An Epicenter                          A host
  the folder: apps, each a code         1. runs `epicenter serve` in the folder, kept running
  repository and a data repository        or started on a request; rebuilds the folder from
  with origins                            Git when it is missing
  `serve`: the launcher, UIs,           2. routes requests to it, and decides who may make them
  actions, MCP                          3. stops it with SIGTERM and allows 10 seconds for
                                           its last backup
```

- **Every file is in Git, a cache, or a credential the person can renew.**
  Code and records are in an app's two repositories. Installed packages, built
  UIs, `mail.local.sqlite`, the files on disk, and the running process are
  caches of Git or of a provider. A `.local` credential, such as Mail's Google
  token (ADR-0882), stays on its computer (ADR-0870) and comes back by
  approving again. An Epicenter keeps no secret of its own.
- **One writer: the host.** Whatever writes an app's files runs where they
  are: an action in `serve`, or an agent on the host such as Claude Code. A
  model or a screen may be anywhere; Claude Code driven from a phone keeps its
  tools on the host. So an app's repositories have one writer and a push-only
  backup (ADR-0851), and nothing has to pull.
- **The clock only maintains.** `serve`'s clock backs up, and an app may give it
  a cache to refresh, such as Mail's sync. It never decides or acts for the
  person. Skipping it loses nothing: a backup pushes what is pending, and a
  sync asks for what changed since it last ran. So a host may stop `serve`
  when nothing calls it.
- **`serve` signs no one in.** It trusts every request it answers, as
  ADR-0864 says, and refuses one a tunnel delivered. On the owner's server
  the host is launchd, which ADR-0878's `epicenter service` installs, and the
  tailnet. `EPICENTER.md` holds only `port`; a `connectors` block left in it is
  refused, by name, as any unknown field is.

## Consequences

- The public listener, the approval page, Better Auth, client metadata
  fetching, `epicenter connectors`, and the `read` scope go, with their tests:
  about 2,700 lines, and the `better-auth`, `@better-auth/core`,
  `@better-auth/mcp` and `@better-auth/cimd` dependencies of the CLI. Reverting
  the commit that removed them restores them.
- claude.ai, ChatGPT, Claude's mobile app, and Claude routines cannot reach an
  Epicenter. Claude Code on the server, driven from a phone, replaces them for
  its owner. A self-hoster who wants a connector would run a separate program in
  front of `serve`, the same piece a hosting service runs; nothing goes back
  into `serve`.
- The Studio's Tailscale Funnel to port 10000 has nothing to forward to. Its
  owner turns it off, and deletes `connectors.local.sqlite` and
  `connectors.local.key` from the Epicenter's folder.
- Folders in an Epicenter that are not apps, and its own `EPICENTER.md` and
  `AGENTS.md`, are in no repository yet, so nothing backs them up. The
  invariant asks for that; [ADR-0884](0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md)
  makes the Epicenter's folder a repository of its own that lists the
  repositories inside it, and `init --from` rebuilds an Epicenter from it.

## Considered alternatives

- **Keep the public listener for a future hosted Epicenter.** Its approval
  needs a tailnet, and a hosting service would approve through its own
  sign-in in front of every container, so the code would be rewritten anyway.
- **Agents bring their own access to providers, so an app holds no
  credentials.** Fits an occasional read an agent starts. It fails Mail: the
  person applies a proposal from a UI with no agent present, a sync of
  thousands of messages would pass through a model, and not every agent has a
  Gmail connector.
- **Secrets encrypted in Git, with one key the host keeps.** Restores
  credentials with the rest, at the cost of one key to guard and every past
  secret in history if it leaks. Today there is one credential, unbuilt
  (Mail's), and on the owner's server a restart keeps `.local` files. It is
  worth reconsidering if a hosted container loses its disk often enough that
  approving again becomes routine.
- **Agents change apps from elsewhere, such as a cloud coding session that
  clones the code repository and pushes.** Makes a second writer, so the host
  would have to pull and merge. For a hosted Epicenter, edit tools offered by
  `serve` over MCP, under a scope only the owner grants, keep one writer; they
  amount to full access to that container, since `serve` imports what they
  write.

## Open

- How a hosted host tells `serve` what a call may do, if a scope comes back.
- A hosting service's grace period against the 10 seconds `serve` waits for its
  last backup.
