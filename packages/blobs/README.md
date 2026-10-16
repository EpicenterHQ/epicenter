# @epicenter/blobs

This package owns the Personal hosted blob URL grammar. The HTTP authority in
`@epicenter/server` parses and mints addresses through it, and its tests use the
same grammar to build request URLs.

| Location | Address |
| --- | --- |
| Personal hosted | `personal/<principalId>/<private|public>/<key>` in the server object store |

Personal hosted objects use complete authority URLs. The path binds principal,
visibility, and a 128-bit random key. The canonical parser rejects another
origin, credentials, queries, fragments, and alternate path encodings. The
server derives the physical key from the URL path.

Publication is a create-only write that returns the complete URL. It is bounded
to 25 MiB (`MAX_HOSTED_BLOB_BYTES`). No in-repo client publishes Personal blobs.

ADR-0544 makes a blob a file in its folder. The LFS wave that implements it
deletes this package and the public Personal blob routes.
