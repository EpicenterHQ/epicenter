# `@epicenter/server`

`@epicenter/server` is the AGPL server engine shared by the hosted and
self-hosted deployments. It owns the Epicenter authority: the two scalar
sync operations, the row-document plane, and the complete server-side SQLite
transaction domain.

Portable wire parsing and latest-state folding live in MIT
`@epicenter/data` (the `./protocol` export). Embedded SQLite API
normalization lives in MIT `@epicenter/sqlite`. Neither package owns server
schema or authority lifecycle.

The authority implementation is in `src/epicenter-sync/authority.ts`.
Runtime-specific Bun and Durable Object owners open that same implementation
through `src/epicenter-sync/bun.ts` and `src/epicenter-sync/cloudflare.ts`.
