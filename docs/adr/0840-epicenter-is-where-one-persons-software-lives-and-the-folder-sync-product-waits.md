# 0840. Epicenter is where one person's software lives, and the folder sync product waits

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Supersedes:** [ADR-0835](0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md), the register of the folder sync product, and so the decisions it lists from [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) to ADR-0834, as governing current work; and the records that amended the register, [ADR-0836](0836-one-merge-a-cursor-that-carries-its-digest-and-one-grant.md), [ADR-0837](0837-the-ledger-is-the-persons-model-folders-the-versions-of-their-files-and-who-may-see-them.md), [ADR-0838](0838-git-speaks-to-a-folder-through-a-remote-helper-and-the-cli-speaks-a-persons-verbs.md), and [ADR-0839](0839-a-save-is-one-numbered-write-a-reset-deletes-nothing-and-epicenter-owns-the-pages-every-app-links-to.md). They stay as the design of a product that waits.
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (what an app is), [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) (an action is a commit, and the repository is the sync), [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) (one table rendered as CLI and MCP, which carries over).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md)
- **Unbuilt:** app discovery in the CLI, the first real app (Mail). `@epicenter/app` is built (`packages/app`).

## Context

Records 0802 to 0839 designed a product for many people: folders that sync
across devices and people, a server that keeps every version, Git at the edges,
web and phone apps, sharing by email. Most of it is unbuilt. Asked what they
will actually use in the next six months, the author answered: Epicenter is for
themselves; they rarely edit on two computers in a week; nothing needs sharing;
they want a Mail app with saved queries and reviewed bulk changes, apps over
their vault, and above all for agents to be able to use every app. Their own
practice already works this way: scripts in `~/Code/vault/scripts/` that Claude
runs.

A three-reviewer council examined the smaller shape and found the evidence for
it in the repository. A 22,000-line Local Mail was deleted in `280bdf4d44`
because it was built on a storage layer that was removed, never because of
Gmail; it never made a live Gmail connection. The apps planned next do not share
one shape: Messages has no cache, Photos scrapes a library, the calendar's
delete is all-or-nothing. And an agent, not a schema, is now what reads one
app's files from another.

## Decision

**For the next six months Epicenter is where one person's software lives.** Each
app is a folder with its code and its data together; every action it defines is
a command in the `epicenter` CLI and a tool for an agent. Epicenter hands each
action a place for data (the app's folder, in Git, readable), a place for things
it can rebuild (a cache), and a place for secrets (the Keychain). Everything else,
from Google sign-in to scraping to SQLite, is the app's business.

**The folder sync product waits.** No ledger, no sync engine, no server holding
history, no sharing, no web or phone app, no live mode. Git is how a folder
moves between computers, run by the person.

**What carries over:** files a person can read; Git as history; one table of
actions rendered as CLI and MCP (ADR-0827); the canonical front-matter rule, as
an optional library for apps whose data is notes.

**Formats follow the reader.** What a person reads or writes is Markdown; what a
machine makes is in its natural readable format (CSV, JSON, SQL); caches are
anything.

## Considered alternatives

- **Keep building the folder sync product.** Rejected for now: it serves people
  who are not using Epicenter, and its cost delayed the one user who is.
- **A platform that runs apps** (one shell hosting apps as views, apps installed
  from links, a phone app containing every app). Rejected for now: no stated
  need, and it requires a sandbox, a runtime, and an install story first.
- **No framework at all, only scripts and skills.** Close to current practice,
  but actions would have no typed input, no `--help`, no `--json`, and no MCP or
  UI without rewriting each script.

## Consequences

- The first build is small: the app contract, discovery in the CLI, and Mail.
- Records 0802 to 0839 do not govern current work. Returning to the sync product
  means a new record that revives what it needs from them.
- A non-developer cannot use Epicenter in this period.
