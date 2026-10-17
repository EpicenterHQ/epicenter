# 0546. A folder syncs to git.epicenter.so under its owner's namespace, and the first push creates it

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amended by:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at the command names `epicenter login` and `epicenter git-credential`, which are `epicenter auth login` and `epicenter auth git-credential`.
- **Amended by:** [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) at "The desktop shell registers the same helper for its runs": the shell runs no `git`, and the `epicenter` CLI's Git uses the helper.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at "`so.epicenter.todos` stays itself" and "clones each into `~/Epicenter/<name>`, where its app looks for it": no app looks for a folder, and a clone takes a free name.
- **Amended by:** [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at `repository_alias`, renaming or moving a repository with an alias, and the consequence that moving or renaming keeps every clone working: there is no rename, move, or alias.
- **Amended by:** [ADR-0595](0595-the-self-hosted-git-store-accepts-a-force-push.md) at "unrelated history is refused as not a fast-forward, so a second folder cannot land in a repository by taking its name": the pushing Git client refuses a push that is not a fast-forward, and a forced push replaces the branch on the self-hosted store.
- **Amended by:** [ADR-0603](0603-a-machine-holds-one-account-grant-in-the-epicenter-cli.md) at "an agent that needs less gets its own grant with a narrower scope and target": an agent uses its machine's one grant.
- **Unbuilt:** the Folders window's Connect and "Clone from Epicenter", deleting a repository, LFS ([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md)), the `git.epicenter.so` route to the Worker, and the Artifacts store's integration checks against the deployed binding. Built: the routes, push-to-create, `GET /api/repos`, the Artifacts and disk stores, rename and move with aliases (server functions, no UI), `GitHost.delete` on both stores, used only to remove the storage a losing concurrent first push made, `epicenter sync --to`, `clone`, and `repos`, and Todos' Connect with its Git token and `POST /api/git/connect` deleted.

## Context

[ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)
put hosted Git behind `POST /api/git/connect { folder }`, which finds or creates
the repository `<folder>.<tag>` (the tag is 16 hex characters of SHA-256 over
the principal id) in one Artifacts namespace and answers a write token for that
repository, valid one hour (`apps/api/worker/git-repositories.ts`). The Worker
forwards Git traffic to Artifacts and lets Artifacts check the token. So:

- every client renews a token through an Epicenter-specific route, which plain
  `git` and agents cannot do;
- the desktop passes the token to `git` through its environment;
- `folder` must be a reverse-domain app id (`isAppId`), so a folder no app owns
  cannot connect;
- the tag, a storage detail, is in every URL;
- nothing lists a person's repositories, so a second machine cannot find them;
- LFS ([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md))
  would have to probe Artifacts to check a token.

Artifacts names repositories with letters, digits, `.`, `_`, and `-`, starting
with a letter or digit; it cannot rename or move one; a binding addresses one
namespace; tokens reach one repository.

## Decision

**A hosted folder's remote is `https://git.epicenter.so/<namespace>/<name>.git`,
and that URL in `remote.origin.url` is the only link between a folder and its
hosted copy.** `<namespace>` is the owner
([ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md));
`<name>` is the repository's name. Nothing in `epicenter.json` names a
repository: a declaration is a folder's shape, and two folders made from one
template share a shape and are still two folders.

**Connect is setting the remote; the first push creates the repository.** The
Folders window and Todos offer Connect, which proposes a name, sets
`remote.origin.url`, and pushes. A push to `<namespace>/<name>` that does not
exist, by a member of that namespace, creates it. A push to one that exists is
an ordinary push: unrelated history is refused as not a fast-forward, so a
second folder cannot land in a repository by taking its name.

**The proposed name is the folder's directory name, made into a valid name;
the person may change it before the first push.** A name is lowercase and unique
within its namespace, so two names never collide on a case-insensitive disk:
letters are lowercased, characters outside `a-z`, `0-9`, `.`, `_`, `-` become
`-`, and it starts with a letter or digit: `so.epicenter.todos` stays itself, `Demo Books` becomes
`demo-books`. After the first push the directory may be renamed freely; the URL
does not change.

**The credential is an access token for `https://git.epicenter.so` from
Epicenter's authorization server
([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)),
given to `git` by a credential helper.** A terminal or an agent's machine runs
`epicenter login`, the device grant (RFC 8628): it shows a code and a link, the
person approves it in a browser where they are signed in and picks the grant's
scopes and target, and the CLI keeps the grant's refresh token in the OS
keychain. `epicenter git-credential` is Git's `credential.helper` for
`git.epicenter.so`: it answers with an eight-hour access token minted from that
refresh token, with `password_expiry_utc`, refreshing under a file lock, so
Epicenter's `git`, a terminal's, and an agent's all authenticate the same way,
and no token is in a URL, in `.git/config`, or in `git`'s environment. The
desktop shell registers the same helper for its runs. A browser app hands its
own access token to isomorphic-git directly. Each grant is listed on the authorization
server's account pages and revoked there; an agent that needs less gets its own grant with a narrower
scope and target.

**Deleting a repository removes it.** Its row, its aliases, and its stored copy
go, and its name is free at once; nothing keeps a tombstone. Every clone holds
the whole history, so a push from any of them creates it again under a new id.
An old clone pointing at a name a different folder has since taken is refused
as unrelated history.

**The server checks the credential and the namespace on every Git and LFS
request, then reaches storage with a token it mints.**

```txt
git.epicenter.so/<namespace>/<name>.git/info/refs?service=…   GET
git.epicenter.so/<namespace>/<name>.git/git-upload-pack       POST
git.epicenter.so/<namespace>/<name>.git/git-receive-pack      POST   (creates on first push)
git.epicenter.so/<namespace>/<name>.git/info/lfs/...          LFS (ADR-0544)
api.epicenter.so/api/repos                                    GET    the caller's repositories, by namespace
```

The store is the replaceable part:

```ts
type GitHost = {
  serve(namespace, name, request): Promise<Response>;   // after authorization
  create(namespace, name): Promise<void>;
  list(namespaces): Promise<Repository[]>;
};
```

**A repository has an immutable id, and storage is named by that id.**

```txt
repository        id (immutable), namespace_id, name           unique (namespace_id, name)
repository_alias  namespace_id, name → repository_id           left by a move or a rename
```

A request's `<namespace>/<name>` resolves through `repository`, then
`repository_alias`, in the same query that checks the credential and the
membership. Moving a repository to another namespace, or renaming it, updates
its row and leaves an alias, so the URL in every existing clone keeps working;
the app rewrites a folder's `origin` to the new URL on its next Sync. The
Artifacts store keeps one namespace per environment (`epicenter-production`,
`epicenter-dev`) and names each repository by its id, which never appears in a
URL; it mints write tokens of 24 hours per repository and caches them. A disk
store for self-host keeps bare repositories at `<root>/<repository id>.git`
behind the same routes.

## Consequences

- Deleted: `POST /api/git/connect`; the hourly token, its renewal in each app
  (Todos' `git-access.ts`), and its storage in the page; the
  token in `git`'s environment on the desktop; `isAppId` as a precondition;
  the tag in URLs; probing Artifacts to check an LFS token.
- A person's other machine lists their repositories and clones each into
  `~/Epicenter/<name>`, where its app looks for it.
- Plain `git clone https://git.epicenter.so/<namespace>/<name>.git` works
  anywhere the credential helper is installed.
- Every Git request costs one database query: the access token, joined with
  the namespace membership (ADR-0547); nothing is cached.
- A typo in a remote creates a private repository in the person's namespace on
  push; it appears in their repository list and is deleted like any other.
  Connect in the app shows the name it will use, so only a hand-typed URL can
  do this.
- Moving a folder into a group, or renaming it, is one row update and an
  alias; no repository is copied and no clone breaks. An alias stays until its
  name is taken by a new repository in that namespace.
- A data folder inside another repository ([ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md))
  syncs with that repository's remote; only a folder that is its own repository
  connects.

## Considered alternatives

- **`POST /api/git/connect` with hourly per-repository tokens** (ADR-0521 as
  first built). Plain `git` and agents cannot renew them.
- **The device's own Better Auth session as the Git credential**, from the
  core `device-authorization` plugin, with Better Auth's API key package for
  narrower keys. A session can change the account, Git's other helpers may
  store it, and the API key package is a fourth credential kind.
- **A token in the remote URL, in `git`'s environment, or in `~/.netrc`.** The
  URL puts it in `.git/config` and logs; the environment reaches only runs
  Epicenter starts; `.netrc` is a plaintext file.
- **A recently-deleted period.** A tombstone on the server, when every clone is
  already the backup.
- **An id in `epicenter.json`.** A declaration is copied with its template; the
  remote URL, and the history behind it, already identify a folder.
- **An explicit create step (`epicenter create`) instead of push-to-create.**
  Avoids stray repositories from typos, but a plain `git push` to a new name
  fails, which breaks "Connect is setting the remote" for agents.
- **The account id with a hash in the repository name.** A storage collision
  solved in public; the namespace in the path solves it and leaves room for
  shared owners.
- **Storage named `<namespace>.<name>`.** Artifacts cannot rename or move a
  repository, so every move or rename would be a copy and a new URL for every
  clone.
- **One Artifacts namespace per owner.** Needs Cloudflare's REST API and an API
  token in the Worker instead of the binding, with undocumented namespace
  limits; worth it only for per-owner data residency, and reachable later by
  changing the store.
