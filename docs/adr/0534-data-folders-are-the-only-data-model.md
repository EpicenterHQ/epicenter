# 0534. Data folders are the only data model

- **Status:** Proposed
- **Date:** 2026-10-14
- **Relates:** [ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) is how folders sync; [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) is where a folder lives.
- **Unbuilt:** marking the store's records superseded, among them ADR-0222, ADR-0292, ADR-0293, ADR-0295, ADR-0298, ADR-0423, ADR-0430, and ADR-0436; deleting the retired Durable Objects' data, which needs a `deleted_classes` migration and a decision about users who still hold it; removing `@epicenter/device` and `@epicenter/sqlite` if nothing else adopts them.

## Context

Two data models ran side by side. The Yjs store (`@epicenter/app`,
`@epicenter/sync`, `@epicenter/app-shell`) kept a database as one Yjs document,
replayed it into a synchronous surface, and synced its update log through one
Durable Object per principal, application, and generation (`StoreAuthority`,
`GenerationsLedger`), relayed on the desktop by the host's account socket.
Local Mail, Skills, and the sync lab were built on it, and Capture could export
old captures from it. Data folders (`@epicenter/folder`) kept Markdown and JSON
files with Git history, and Todos, Whispering, Capture, Vocab, and Honeycrisp
used them. ADR-0521 makes Git the sync path for folders, which left the store
sync serving only the store's own apps.

## Decision

**Data folders are the one data model; the Yjs store is removed.** The packages
`@epicenter/app`, `@epicenter/sync`, `@epicenter/app-shell`, and
`@epicenter/skills` are deleted, with the apps built only on them:
`apps/local-mail`, `apps/skills`, and `apps/sync-lab`. Git history keeps them;
returning means restoring them, not porting them.

What survives moved:

| From | To |
| --- | --- |
| AI and inference in `@epicenter/app`, the inference picker in `@epicenter/app-shell` | `@epicenter/ai` |
| `@epicenter/app/field` (a re-export) | `@epicenter/definition/field` |
| `SyncRefusal`, which `AccountUnavailable` carried | `AccountRefusal` in `@epicenter/auth` |

**Nothing serves store sync.** `mountStoreSyncApp`, the desktop host's
`/_epicenter/account/sync` relay, and `Account.openWebSocket` are removed.
`StoreAuthority` and `GenerationsLedger` stay exported as empty classes
(`packages/server/src/retired-sync.ts`) from `apps/api` and the self-host Worker,
so a deploy does not delete the data they hold; the self-host Bun server no
longer opens its `sync/` directory.

**Desktop Mail is a placeholder.** Its built-in route and window ID stay
reserved and serve a placeholder page, like Books, so its deep link keeps its
meaning.

## Consequences

- About 110,000 lines are gone, counting the deleted apps with their tests and
  evidence. Every remaining app has one way to keep and sync data.
- People who used Local Mail or Skills lose those apps. Their synced store data
  stays on the server, unread, until a deletion is decided.
- Capture imports only an export file saved earlier; it no longer reads the old
  account store.
- No folder app syncs in real time; a sync is an explicit Git transfer
  ([ADR-0489](0489-folder-transfers-happen-only-when-a-person-syncs.md)).
- Historical records and reports that cite deleted files keep their text, with
  `doc-path-check` markers.

## Considered alternatives

- **Port Local Mail, Skills, and the sync lab to folders first.** Local Mail's
  mailbox mirror does not map onto files without its own design, and none of
  the three is in active use.
- **Keep the store sync running for those apps.** Two sync paths, two auth
  surfaces (sockets and Git), and a server that holds both.
- **Delete the Durable Objects' data now.** Irreversible, and nothing yet says
  whether anyone needs an export first.
