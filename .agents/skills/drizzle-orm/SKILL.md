---
name: drizzle-orm
description: Drizzle ORM in Epicenter: the Postgres schema in packages/server, migrations from apps/api, and the Postgres-only dialect. Use when editing Drizzle schemas, running drizzle-kit, or changing migrations.
metadata:
  author: epicenter
  version: '1.0'
---

# Drizzle ORM

Drizzle is Postgres only here. `apps/api/drizzle.config.ts` declares `dialect: 'postgresql'`, and only `drizzle-orm/pg-core` and `drizzle-orm/node-postgres` are imported. No Drizzle code targets D1 or SQLite; a SQLite question is about a different engine.

- The schema lives in `packages/server/src/db/schema/` (`index.ts` is the entry), not in `apps/api`. `createDb` in `packages/server/src/db/create-db.ts` binds it to a `pg` client or pool; drizzle-kit reads the same `index.ts` through the config.
- Migrations are generated SQL in `apps/api/drizzle/`. Change the schema, run `bun run db:generate` in `apps/api`, and review the SQL with the snapshot before committing.
- When behavior of a column type or drizzle-kit matters, check the installed `drizzle-orm` types or the official docs; there is no other Drizzle code here to copy from.
