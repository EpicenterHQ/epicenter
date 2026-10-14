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

| # | Phase | Branch | State |
| --- | --- | --- | --- |
| 1 | Records match the decisions: ADR-0521 fixes the issuer per build; ADR-0489 rewritten; ADR-0490 and the GitHub pairing spec deleted | `claude/folder-greenfield` | done, `0eb16600c8` |
| 2 | `@epicenter/folder/bun` opens through the shared directory layer; native store, exchange add-on, and their tests deleted; names read literally | `claude/folder-greenfield` | done, `063f598956`; symlink classification restored in `a70f1b7269` |
| 3 | Desktop gate: Save version, private-remote Sync, two windows, outside `git` against `index.lock`, on a real desktop run of branch 1 | `claude/folder-engine-tauri-fs` | waiting for a person at the desktop; two windows settled from code: the host keeps one window per app (`ensure_window`), so a second Todos window cannot open |
| 4 | Yjs removed: Local Mail, Skills, sync lab deleted (`280bdf4d44`); AI moved to `@epicenter/ai` (`52ddcdc2b8`); store, sync, relay, and sockets deleted with empty Durable Object placeholders (`9f75a9bd51`); ADR-0534 | `claude/remove-yjs` | done |
| 5 | Account partitions removed: installed apps open `<root>/<app-id>/`; hosted pairing relays (`hosted.rs`, `binding.rs`, `account-git-relay.ts`), the folder plugin's download and relayed transport, `require_existing_repository`, the ready frame's `bootAccount` and the native folder owner capture, Home's Download, `account_key`, `accountKey`, ADR-0461 and ADR-0496 deleted | `claude/remove-partitions` | done |
| 6 | Hosted Todos: `mountGitApp` with the Artifacts store in `apps/api`, `/api/git/connect`, the folder engine's per-transfer `credentials`, the desktop's URL-scoped credential in `run_git`, the Sync panel; the GitHub connector (migration `v7`) and picker deleted | `claude/hosted-git` | built and checked live in Chromium and with system `git` on a throwaway Worker; a desktop run of it waits on phase 3 |
| 7 | Whispering audio through LFS: the engine's LFS client and an R2 LFS endpoint | later | |

## Decisions made while building

- Zero users: no migration and no compatibility. Folders left under `local/`
  and `accounts/` are neither moved nor opened (ADR-0532). The standalone
  Honeycrisp and Whispering shells still write `~/Epicenter/local/<scope>`;
  that is theirs and unchanged.
- Installed apps get hosted sync back by moving to page-engine scopes
  (ADR-0531), not by a token in the Rust owner, so the plugin's `Transport`
  seam is deleted rather than kept for phase 6.
- The ready frame names only the installed IDs (protocol 11): nothing about an
  installed app's folder depends on who is signed in.

- Phase 6's design was reviewed before building (two independent reviewers
  converged; ADR-0521 records it) and after. The second review's fixes are in:
  the Bun runner drops inherited trace settings, which could print the
  credential header; a sign-out during token renewal refuses the transfer
  instead of sending none; renewal follows the server's `expiresIn`; a remote
  URL carrying a password is refused; `run_git` takes only the header value and
  scopes it to the origin it reads itself.
- Not built, by choice: `GET /git/repos` (no caller; Artifacts lists only whole
  namespaces); metering hosted Git; a bundled credential helper to keep the
  desktop token out of the `git` process's environment (ADR-0521 Consequences).

## Open items

- Phase 3 needs a person at the desktop, or a computer-use session approved
  for "Epicenter Dev". Two windows on one folder cannot happen: the host keeps
  one window per app (`ensure_window`).
- Next wave: move Capture and installed apps to page-engine folders, then
  delete the Rust folder owner (both reviewers' largest deletion prize). It also
  gives installed apps hosted sync, after connect is scoped per app
  (ADR-0521 Consequences), and makes their transfers reread `origin`
  (ADR-0532 Unbuilt).
- Before deploying `apps/api`: `wrangler secret put ARTIFACTS_ACCOUNT_ID`
  (required secret). The deploy runs migrations `v6` and `v7`, which delete the
  store sync's Durable Objects and every stored GitHub grant. The Artifacts
  namespace is `epicenter-production`.
- The empty Artifacts namespace `epicenter-livetest` from the live check is
  left on the Epicenter account: wrangler cannot delete a namespace; the REST
  API (`DELETE /artifacts/namespaces/epicenter-livetest`) or the dashboard can.
- `@epicenter/folder`'s `browser.httpFetch` has only test callers now; folding
  it into an internal test seam is a separate cleanup.
- The next `apps/api` deploy runs migration `v6`, which deletes the store sync's
  Durable Objects and their data; the self-host Worker's `v3-retire-store-sync`
  does the same.
- ADR-0534 names the store records to mark superseded; changing an Accepted
  record's status is the owner's call.
- `@epicenter/device` and `@epicenter/sqlite` lost their main consumers;
  `packages/vite-config` still carries `@epicenter/device`'s worker settings.
- `apps/landing` still advertises `@epicenter/app/store`.
