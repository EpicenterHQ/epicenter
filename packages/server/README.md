# `@epicenter/server`

`@epicenter/server` is the AGPL server library shared by the hosted cloud and
the self-hosted single-partition instance. Deployments choose authentication
and runtime bindings; the library owns the record authority, document and blob
publication, Backup and Restore, and the reusable HTTP and WebSocket mounts.

The durable scalar identity is one structured `RecordAddress` from
`@epicenter/data/protocol/v1`:

```ts
type RecordAddress = {
	namespace: string;
	collection: string;
	recordKey: string;
};
```

Portable parsing, folding, and replica behavior stay in the MIT data package.
The AGPL server package owns authority schema and lifecycle.

## Record authority

`src/epicenter-sync/authority-v1.ts` implements the scalar authority over the
exact schema in `authority-v1-schema.ts`. Document and blob state join that
owner through `document-authority-v1.ts` and `blob-authority-v1.ts`.

Runtime owners expose the same protocol:

- `scalar-v1-bun.ts`: Bun SQLite authority and WebSocket owner.
- `scalar-v1-cloudflare.ts`: Cloudflare `DataAuthority` Durable Object.
- `scalar-v1-route.ts`: fact reads and numbered intent submissions.
- `document-v1-route.ts`, `document-realtime-v1-route.ts`, and
  `blob-v1-route.ts`: record-addressed child planes.

There is no legacy `EpicenterAuthority`, kinded row/value exchange, or
`@epicenter/data/protocol` dependency.

## Deployment composition

The main export contains Cloudflare owners and shared mounts. The `/bun` export
contains Bun owners and the closed WebSocket handler merge. `apps/api` and
`apps/self-host` compose those parts independently because their principal,
authentication, billing, and database policies differ.
