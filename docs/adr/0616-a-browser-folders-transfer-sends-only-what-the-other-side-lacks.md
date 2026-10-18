# 0616. A browser folder's transfer sends only what the other side lacks

- **Status:** Proposed
- **Date:** 2026-10-18

## Context

A browser folder's Sync fetched with isomorphic-git's `git.fetch` and pushed
with `git.push` (`packages/folder/src/git/browser-backend.ts`). Both cost what
the history holds, not what changed, and a namespace of a few hundred rows
was as far as a tab went.

- **Fetch.** With `singleBranch`, `git.fetch` sends one `have` line: the
  local branch head. Sync checkpoints a save before it fetches, so whenever
  the folder had a change the remote had not seen, that head was a commit the
  server did not know, the server found nothing in common, and it sent the
  whole history again. Each such Sync stored another full pack.
- **Push.** `git.push` walks commits from the pushed one until it reaches a
  commit the remote advertised. Sync's merge has the fetched remote head as
  one parent and the folder's own commit as the other; that commit's parent
  is an older remote commit no ref names, so the walk went on to the root
  commit. It then listed every tree of every commit it passed and sent each
  object that was not in the merge base's tree: old blob versions included.
  Whether it subtracted even that depended on the server not advertising
  `no-thin`.

Measured over `git http-backend` with 2,000 files and 50 commits (10,000
files and 200 commits), in `packages/folder/src/git/transfer.test.ts`'s
setup:

| Transfer of one changed file | isomorphic-git | this decision |
| --- | --- | --- |
| fetch, folder holding a commit the remote lacks | 2,207 objects (10,807) | 4 (4) |
| push of Sync's merge | 211 objects, 178 ms (811, 2.2 s) | 7, 53 ms (7, 107 ms) |
| push of a fast-forward | 4 objects | 4 |

## Decision

**Browser Git speaks Git's smart HTTP protocol (v0) itself, in
`packages/folder/src/git/transfer.ts`: `fetchRef` and `pushRef`.**
isomorphic-git does only object work there: reading commits and trees,
`git.indexPack` for a received pack, and `git.packObjects` for one to send.
`git.fetch` and `git.push` are not called anywhere in the browser backend.

- **A fetch offers two `have` lines:** the remote-tracking commit
  (`refs/remotes/origin/<branch>`) and the local branch head, each only if it
  is stored here. The server knows the tracking commit, since the folder last
  fetched or pushed it, so it sends only what that commit does not reach. The
  request asks for `side-band-64k` and `ofs-delta` when offered, and never
  for `thin-pack` or `multi_ack`.
- **A push sends the commits no advertised ref reaches,** found by a walk
  newest first that marks every ancestor of an advertised ref held and stops
  once only held commits are queued, as Git's own revision walk does. For
  each new commit it sends the commit and, of its tree, only the entries no
  parent's tree holds at the same path. Every parent is held by the remote or
  sent in the same pack, so the pack is complete without depending on
  `no-thin`. Only refs the server advertised count as held: the tracking ref
  is not trusted, because the remote may have been reset since.
- **Each successful transfer writes `refs/remotes/origin/<branch>`** to the
  commit fetched or pushed. Git configuration no longer carries a
  `remote.origin.fetch` refspec; nothing reads it.

The native backend is unchanged: system `git fetch` and `git push` already
negotiate this way (ADR-0559).

## Consequences

A fetch and a push cost the objects that changed, plus one walk of the
commits the remote lacks and of the changed paths of their trees. A remote
whose history the folder shares nothing with still sends everything, as it
must.

Smart HTTP framing, the advertisement, `ACK`/`NAK`, side-band
demultiplexing, and `report-status` are this package's code, about 400
lines. A push requires the server to offer `report-status`. A remote URL
that carries a username and password is no longer turned into an
`Authorization` header; credentials come from `GitCredentials` only.

A clock skewed enough to stop the push walk early makes a held commit look
new, which sends objects the remote already has; it never omits one.

## Considered alternatives

- **Pass the tracking ref as `git.fetch`'s `ref`.** With `singleBranch`, that
  argument chooses the one `have`, so the fetch would be fixed in one line by
  an undocumented side effect, and the push would still walk to the root.
- **Keep `git.push` and fix only the fetch.** A fast-forward push already
  sent four objects against `git http-backend`; Sync's merge push, the common
  one, did not.
- **`singleBranch: false`.** Offers every local ref as a `have`, but also
  wants and records every remote branch.

## References

- [Git smart HTTP](https://git-scm.com/docs/gitprotocol-http) and
  [pack protocol](https://git-scm.com/docs/gitprotocol-pack).
- [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md):
  the Sync whose checkpoint, fetch, merge, and push these are.
