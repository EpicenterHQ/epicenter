# @epicenter/blobs

This package owns the Personal hosted blob URL grammar. The HTTP authority in
`@epicenter/server` and the Account-bound client in `@epicenter/client` both
parse and mint addresses through it, so they cannot disagree about one.

| Location | Address |
| --- | --- |
| Personal hosted | `personal/<principalId>/<private|public>/<key>` in the server object store |

Personal hosted objects use complete authority URLs. The path binds principal,
visibility, and a 128-bit random key. The canonical parser rejects another
origin, credentials, queries, fragments, and alternate path encodings. The
server derives the physical key from the URL path.

Personal publication uses `createPersonalHostedBlobs(account)` from
`@epicenter/client`. The client has `publishPrivate`, `publishPublic`,
`download`, and `delete`; it returns the complete URL after a create-only write.
Publication is bounded to 25 MiB (`MAX_HOSTED_BLOB_BYTES`).

ADR-0544 makes a blob a file in its folder. The LFS wave that implements it
deletes this package and the public Personal blob routes.
