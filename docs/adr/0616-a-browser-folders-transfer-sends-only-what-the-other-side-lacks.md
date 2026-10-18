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
| push of Sync's merge | 211 objects, 181 ms (811, 2.2 s) | 7, 54 ms (7, 107 ms) |
| push of a fast-forward | 4 objects | 4 |

## Decision

**The fetch stays on isomorphic-git's `git.fetch` and offers the
remote-tracking commit as its `have`; the push is this package's own, in
`packages/folder/src/git/push.ts` (`pushRef`).**

- **Fetch.** `git.fetch` is called with `singleBranch` and
  `ref: refs/remotes/origin/<branch>`. With `singleBranch`, isomorphic-git
  sends `ref` as its one `have` line and, since `remote` and `remoteRef` are
  given, uses it for nothing else. The server knows the tracking commit,
  since the folder last fetched or pushed it, so it sends only what that
  commit does not reach. This relies on isomorphic-git 1.38.5's behavior;
  `packages/folder/src/git/transfer.test.ts` asserts the `have` line and the
  object count, so an upgrade that changes it fails there. The fetch stays on
  isomorphic-git because its upload-pack client is one real servers have
  exercised, and the production store, Cloudflare Artifacts, has no
  integration test in this repository to catch a client of our own.
- **Push.** `pushRef` speaks receive-pack over smart HTTP (protocol v0),
  with isomorphic-git doing only object work: reading commits and trees, and
  `git.packObjects`. It sends the commits no ref the server advertised
  reaches, found by a walk newest first that marks every ancestor of an
  advertised ref held and stops once only held commits are queued, as Git's
  own revision walk does. Only advertised refs count as held: the tracking
  ref is not trusted, because the remote may have been reset since.
- **The push's invariant is parents first.** The new commits are taken in an
  order where each comes after every parent among them. For each it sends the
  commit and, of its tree, only the entries no parent's tree holds at the
  same path. When a commit is compared with a parent, that parent is either
  held by the remote or already entirely in the pack, so a tree once added
  is complete and is never expanded again, and the pack needs nothing the
  remote lacks, whether or not the server offers `no-thin`. Taken newest
  first instead, a later commit could mark a tree sent that it had only
  partly expanded, and the earlier commit that introduced the rest found it
  already marked: `git http-backend` refused the push as missing objects.
- **A push requires the server to offer `report-status`,** and refuses an
  advertisement in protocol version 2 or with a line that names no ref.
- **Each successful push writes `refs/remotes/origin/<branch>`;**
  `git.fetch` writes it for a fetch, through the `remote.origin.fetch`
  refspec `setRemote` configures.
- **A remote URL with a username or password is refused by `setRemote`.** A
  browser's `fetch` throws an opaque error for one; credentials come from
  `GitCredentials`.

The native backend is unchanged: system `git fetch` and `git push` already
negotiate this way (ADR-0559).

- **Unverified:** a push to Cloudflare Artifacts. Every measurement and test
  ran against `git http-backend`; an Artifacts smoke test of `pushRef` is
  outstanding.

## Consequences

A fetch and a push cost the objects that changed, plus one walk of the
commits the remote lacks and of the changed paths of their trees. A remote
whose history the folder shares nothing with still sends everything, as it
must.

Receive-pack framing, the advertisement, and `report-status` are this
package's code, about 370 lines in `push.ts`.

A clock skewed enough to stop the push walk early makes a held commit look
new, which sends objects the remote already has. Commits wrongly taken as
new are still taken parents first, so the pack stays complete.

## Considered alternatives

- **Our own fetch as well.** A first version offered both the tracking
  commit and the branch head. The branch head helps only when the server
  holds it but the tracking ref is stale, which a push that records the
  tracking ref leaves rare, and the client was one more protocol
  implementation no production store tests.
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
