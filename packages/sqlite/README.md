# `@epicenter/sqlite`

`@epicenter/sqlite` is the MIT embedded-SQLite substrate shared by the browser,
Bun, and Cloudflare Durable Object runtimes. It normalizes synchronous queries
and transactions without owning any application schema, synchronization state,
or product lifecycle.

Schema and transaction invariants belong to the consuming package. Client
record and replica storage lives in `@epicenter/data`; server authority storage
lives in `@epicenter/server`.
