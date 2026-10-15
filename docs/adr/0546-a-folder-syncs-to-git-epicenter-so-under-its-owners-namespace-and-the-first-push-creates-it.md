# 0546. A folder syncs to git.epicenter.so under its owner's namespace, and the first push creates it

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** all of it: the `git.epicenter.so` routes, push-to-create, `GET /api/repos`, device Git tokens, `epicenter login` and `epicenter git-credential`, Connect and "Clone from Epicenter" in the Folders window, and Todos moving off `POST /api/git/connect`.

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

**The credential is a device Git token, given to `git` by a credential
helper.** A person signs in once per device (`epicenter login`, or signing in to
the app), which issues a token scoped to Git and LFS on that person's
namespaces, listed and revocable per device in Settings.
`epicenter git-credential` is Git's `credential.helper` for `git.epicenter.so`,
so Epicenter's `git`, a terminal's, and an agent's all authenticate the same
way. The desktop shell sets the helper for its runs instead of passing a header
in `git`'s environment. A browser sends its session's token on the same routes.

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

The Artifacts store keeps one namespace per environment (`epicenter-production`,
`epicenter-dev`) and names a repository `<namespace>.<name>`, which never
appears in a URL; it mints write tokens of 24 hours per repository and caches
them. A disk store for self-host keeps bare repositories at
`<root>/<namespace>/<name>.git` behind the same routes.

## Consequences

- Deleted: `POST /api/git/connect`; the hourly token, its renewal in each app
  (`apps/todos/src/lib/git-access.ts`), and its storage in the page; the
  token in `git`'s environment on the desktop; `isAppId` as a precondition;
  the tag in URLs; probing Artifacts to check an LFS token.
- A person's other machine lists their repositories and clones each into
  `~/Epicenter/<name>`, where its app looks for it.
- Plain `git clone https://git.epicenter.so/<namespace>/<name>.git` works
  anywhere the credential helper is installed.
- Every Git request costs one database query: the device token, joined with
  the namespace membership (ADR-0547); nothing is cached.
- A typo in a remote creates a private repository in the person's namespace on
  push; it appears in their repository list and is deleted like any other.
  Connect in the app shows the name it will use, so only a hand-typed URL can
  do this.
- Moving a repository to another namespace is a copy (Artifacts cannot move),
  and every clone's `origin` changes.
- A data folder inside another repository ([ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md))
  syncs with that repository's remote; only a folder that is its own repository
  connects.

## Considered alternatives

- **`POST /api/git/connect` with hourly per-repository tokens** (ADR-0521 as
  first built). Plain `git` and agents cannot renew them.
- **An id in `epicenter.json`.** A declaration is copied with its template; the
  remote URL, and the history behind it, already identify a folder.
- **An explicit create step (`epicenter create`) instead of push-to-create.**
  Avoids stray repositories from typos, but a plain `git push` to a new name
  fails, which breaks "Connect is setting the remote" for agents.
- **The account id with a hash in the repository name.** A storage collision
  solved in public; the namespace in the path solves it and leaves room for
  shared owners.
- **One Artifacts namespace per owner.** Needs Cloudflare's REST API and an API
  token in the Worker instead of the binding, with undocumented namespace
  limits; worth it only for per-owner data residency, and reachable later by
  changing the store.
