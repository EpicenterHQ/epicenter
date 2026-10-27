# Staged Git promotion probe

**Question:** Can a candidate already stored under a temporary ref be promoted to
`main` by an old-OID-checked Git receive-pack request without resending its
objects?

On 2026-10-22, a disposable local bare repository held commit A on `main` and
commit B on `refs/heads/__epicenter_stage_probe`. A receive-pack request
`A B refs/heads/main` with no pack returned `unpack eof before pack header was
fully read` and did not move `main`. The same command with a canonical 32-byte
empty pack returned:

```text
unpack ok
ok refs/heads/main
```

`main` then named B. Repeating the command with old A returned `ng
refs/heads/main failed to update ref`; deleting the stage with its exact old B
and an empty pack succeeded. The probe removed its temporary repository.

On 2026-10-22, disposable repositories in the production Artifacts namespace
repeated the probe through a locally running Worker with a remote Artifacts
binding (Wrangler 4.145.0). A staged B was immediately visible to
`readCommit(B)` with parent A. An empty-pack `A -> B` promotion returned `ok`
for `main`; a stale `A -> B` returned `ng ... stale ref`. An initial stage on an
empty repository followed by `0 -> B` on `main` also succeeded, and repeating
the zero-old update was rejected. Staging refs were deleted. A further probe
read B's tree and blob and read `file.txt` by commit OID through the binding.

Artifacts also accepted `git push --atomic` creating `main` and
`refs/epicenter/ops` together. A later raw `report-status atomic` request moved
both refs from A to B. When the `main` old OID was stale but the operations-ref
update was otherwise valid, **both** commands returned `ng` and the operations
ref stayed at B. The binding could read a file by the operations commit's OID,
but `readFile` and `log` did not resolve that custom ref by name, even when it
was under `refs/heads/`. Git `ls-remote` did see it. The service can obtain both
ref OIDs from an internal v1 advertisement, then use immutable OIDs for binding
reads. This has not yet been exercised through a full gateway.

On 2026-10-22, a further disposable Worker with the same remote binding used
`crypto.subtle.digest('SHA-1')` and `CompressionStream('deflate')` to construct
five ordinary Git objects itself: a blob, a one-file tree, an empty tree, a
first `main` commit, and an initial operations-ledger commit. It serialized a
Git pack, sent one `report-status atomic` receive-pack request for zero-old
`main` and `refs/epicenter/ops`, and received `ok` for both refs (HTTP 200).
An independent Git fetch read both advertised commit OIDs, `git show` read
`note.md` with the Worker's exact content, and Git identified the ledger's
tree as the canonical empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`. This directly establishes
that the Worker runtime can author valid Git objects and the first atomic
two-ref publication. It does not yet establish the P/M merge algorithm or a
complete native gateway. The probe repository was deleted, the namespace
listed `[]`, and the local Wrangler Worker was stopped.

Each disposable repository was deleted in a `finally` block. A subsequent
Wrangler list returned an empty namespace. No production Worker was deployed.
The local development Worker was stopped.

The tests establish these Artifacts primitives, not the full gateway. Real
client framing, hidden-ref filtering (including upload-pack v2), crash cleanup,
and concurrent native/client pushes remain to verify.

[Cloudflare's Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
documents receive-pack v1. The current [Workers binding documentation](https://developers.cloudflare.com/artifacts/api/workers-binding/)
documents `readCommit`, `readTree`, `readBlob`, and `readFile`, and requires
Wrangler 4.145.0 or later for current generated types. This checkout's
generated binding types are older.

The throwaway probe was removed after recording the result. Its essential
request is one pkt-line update, a flush packet, then `PACK`, version 2, object
count 0, and SHA-1 of the 12-byte pack header.
