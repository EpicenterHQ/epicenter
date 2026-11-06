# 0808. A file's version is its Git blob id on every store

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "A version is the name Git gives the content, the blob id of a note and the Git LFS object id of any other file": an attachment's version is the blob id of its canonical Git LFS pointer, and its object id addresses its bytes; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at a store naming an attachment by a stamp: a stamp is only a cache of the hash; [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) at `write(path, bytes | null, over)` and `'stale'`: a store's write is `put(path, bytes | null, expect)`, failing with `Moved`; [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at the manifest holding each file's commit: it holds `{ commit, files: path → blob id }`; [ADR-0807](0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md) at attachments read through the repository and held by reference on the web: bytes have one stable address for every client, and holding them is each store's policy.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0803](0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) (people may clone and push with Git), [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (every other file is kept whole in Git LFS).
- **Unbuilt:** all of it: the store contract's `put` and `Moved`; every store answering blob ids; the manifest without `at`, a merge's base read by blob id; the server serving a note's blob by id and an attachment's bytes at `/<repository>/blobs/<sha256>` (GET streamed with `Cache-Control: private, immutable`, PUT checked), for every client in place of Git LFS; each store's eager or on-demand policy; the server refusing a pushed LFS pointer that is not canonical; the attachment stamp cache in `.epicenter/` with Git's racy-clean rule; the recorder hashing while it writes; the server's API named as Git's data model.

## Context

A store's version meant three things: the sha256 of a note's bytes on a
computer, a stamp for an attachment so a listing never read a recording, and
the Git blob id on the server, with sync translating between them. Its write
took `over: Version | 'absent'` and answered `'stale'`, sentinels in the
types, and the web's memory store held attachments by reference as a special
case. An adversarial review of three reviewers agreed that one version kind
removes the translation, and that the kind is the one the server already
reads off its trees without reading a file: Git's blob id. Hashing every note
as sha256 on the server would have needed an index filled on its own writes
and on every push. Attachment bytes came through signed storage links that
expire in fifteen minutes, so no browser cache could keep them.

## Decision

**A file's version is the Git blob id of what the repository stores at its
path, on every store.** For a note it is the blob id of the note's bytes,
which a client computes from them. For an attachment it is the blob id of its
canonical Git LFS pointer, which a client computes from the attachment's
sha256 and size. The server reads every version off its trees.

**Bytes are addressed apart from versions, at one address for every Epicenter
client.** A note's bytes by its blob id; an attachment's by its sha256, at
`/<repository>/blobs/<sha256>`: `GET` reads it, streamed from storage with
`Cache-Control: private, immutable`, and `PUT` uploads it, idempotent and checked
against its hash. Every address is scoped to a repository and authorized, and
every read is checked against its id. Epicenter's clients speak no Git LFS;
its protocol stays for people who push and clone with plain Git.

**Whether a store holds an attachment's bytes is the store's policy.** Every
entry is a version and an address. A desktop store fetches bytes as they arrive,
so recordings work offline; the web's memory store, and a phone's where space
matters, fetch them when they are read. A browser's cache usually keeps them
across reloads.

**A store writes with `put(path, bytes | null, expect: BlobId | null)`.** It
answers the blob id that landed, or null for a removal, or fails with
`Moved { now }`, carrying what the path holds; `expect: null` means nothing is
there. A `Moved` whose `now` is the id the writer meant to land is a reply that
was lost, and counts as landed.

**The manifest is `{ commit, files: path → blob id }`.** A merge reads its base
text by blob id, so no file records the commit it agreed at.

**A pushed LFS pointer must be canonical.** The server refuses another layout,
as it refuses a path that collides by case, so an attachment's version is the
same on every computer.

**A computer caches an attachment's hash by its stamp**, in `.epicenter/`,
derived and deletable, never for notes: a file whose modification time is at
or after its entry's is hashed again, and an attachment is hashed again before
a write replaces it. The recorder hashes a take while it writes it.

**The server's sync routes use Git's own vocabulary**: blobs, trees, commits,
and a branch updated only where it still points where the writer expected.

## Consequences

- One version kind, with no translation between stores.
- The store contract holds no sentinel strings.
- An attachment held without its bytes is an ordinary entry, on any surface:
  its version, and an address to fetch it.
- A client reads or uploads a blob in one request, with no expiring link.
- The server adds no index; recording traffic passes through it.
- A person who pushes a pointer from another Git LFS tool is refused until it is
  canonical.

## Considered alternatives

- **The sha256 of every file's bytes as the version:** one hash, and the server
  must hash every note or keep an index filled on every push.
- **Signed storage links for attachment bytes, through Git LFS's batch
  protocol:** no audio through the server, two requests per blob, a link that
  expires, and a recording played after a reload downloads again.
- **A stable address for the web alone:** a second way to fetch bytes, serving
  one surface.
- **Comparing attachments by sha256 and size:** tolerates any pointer layout,
  and keeps a second kind of version.
