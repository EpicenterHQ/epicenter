# Git sync collapse

**Date**: 2026-10-14
**Status**: In Progress
**Owner**: Braden; Claude implements in the `claude/*` stack, Codex verifies and integrates

## One sentence

Every app's data is a Git folder that syncs over plain Git with a token to the
server it was built for, and everything that existed only for Yjs sync, GitHub
pairing, or account-partitioned folders is removed.

## Decisions this plan carries out

- [ADR-0521](../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md):
  Git smart HTTP with a token is the app-to-server contract; hosted is a Worker
  in front of Artifacts; the sign-in server is fixed per build and is also the
  Git server.
- [ADR-0532](../docs/adr/0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md):
  a folder is `<root>/<folder-id>/`, with no account in the path.
- [ADR-0533](../docs/adr/0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md):
  one folder handle in three hosts; Bun replaces files the way the desktop does.
- Yjs sync is removed now and can be restored from Git history later.
  `apps/local-mail`, `apps/sync-lab`, and `apps/skills` are deleted, not ported.

## Phases

Each phase lands as its own commits on its own `claude/*` branch, stacked on
the previous one, and ends with the checks it names passing.

| # | Phase | Branch | Done when |
| --- | --- | --- | --- |
| 1 | Records match the decisions: ADR-0521 fixes the issuer per build; ADR-0489 rewritten against 0521; ADR-0490 deleted; dead references in 0515 and 0516 repointed | `claude/folder-greenfield` | `check:doc-paths`, `check:doc-hygiene` show nothing new |
| 2 | `@epicenter/folder/bun` opens through the shared directory layer; the native store, exchange add-on, and their tests are deleted | `claude/folder-greenfield` | `packages/folder` tests and typecheck pass |
| 3 | Desktop gate: Save version, private-remote Sync, two windows, outside `git` against `index.lock`, on a real desktop run of branch 1 | `claude/folder-engine-tauri-fs` | results recorded in ADR-0531 |
| 4 | Yjs removed: sign-in and blobs untangled from `@epicenter/sync`; sync routes, Durable Objects, packages, and the three apps deleted; `capture` and `vocab` keep their folder features | `claude/remove-yjs` | root `check` passes for the remaining workspace |
| 5 | Account partitions removed: installed apps open `<root>/<app-id>/`; hosted pairing relays, `account_key`, `accountKey`, ADR-0461 and ADR-0496 deleted | `claude/remove-yjs` | desktop host tests pass |
| 6 | Hosted Todos: `mountGitApp` with the Artifacts store in `apps/api`, `/git/connect`, the plain-token transport, the Sync panel; the GitHub connector and picker deleted | `claude/hosted-git` | Todos syncs through a dev deployment in a real browser |
| 7 | Whispering audio through LFS: the engine's LFS client and an R2 LFS endpoint | later | — |

## Open items

- Phase 3 needs a person at the desktop, or a computer-use session.
- Phase 4's removal order comes from an inventory of what `@epicenter/auth`
  and `@epicenter/server` import from the Yjs packages.
- Durable Objects removed in phase 4 need deleted-class migrations, not
  silent removal, in each `wrangler.jsonc` that declared them.
