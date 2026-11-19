# 0970. The hosted API is retired

- **Status:** Proposed
- **Date:** 2026-11-18
- **Relates:** [ADR-0899](0899-the-folder-sync-product-is-retired.md), which retired the folder sync product the same way; [ADR-0950](0950-api-epicenter-so-is-a-model-api-and-every-client-reaches-it-with-an-api-key.md) and [ADR-0951](0951-ai-credits-follow-what-a-call-uses-held-before-it-and-settled-after.md), whose plans this abandons.

## Context

`apps/api` was the hosted service at `api.epicenter.so`: sign-in, AI
inference, transcription, and billing through Autumn, with a SvelteKit
account website in `apps/api/ui` for sign-in, consent, device approval,
credits, and usage. `packages/server` held its routes and `packages/account`
its account client. It ran as a Cloudflare Worker and, for self-hosting, on
Bun with Postgres.

Nothing shipped depends on it now. Whispering's sign-in was removed after
v7.11.0, and that release contains no reference to `api.epicenter.so`.
Whispering, `packages/app`, and the landing site make no runtime call to the
API. The owner stopped working on it, and keeping it cost a workspace, a
deploy step, a PostgreSQL install in the merge gate, four skills, and a share
of every dependency update.

## Decision

The repository no longer contains or deploys the hosted API, for now. This change
deletes `apps/api` (with `apps/api/ui`), `packages/server`, `packages/account`,
the API-only provider catalog in `packages/ai`, the API deploy step, the
PostgreSQL step in the merge gate, `check:api-paths`, the Biome rule for the
API's error bodies, and the `auth`, `autumn`, `hono`, and `drizzle-orm` skills.

`packages/ai` stays: Whispering's model layer uses it.

## Consequences

- Removing the deploy step stops republishing; it takes nothing down. The live
  Worker, its database, its Infisical secrets, Autumn billing, and any paid
  plans or credit balances stay as they are until the owner retires them
  outside the repository.
- ADR-0950 and ADR-0951 described the API's next shape. Their plans are
  abandoned.
- Records that describe the API stay as history. Those that name its deleted
  files carry the `doc-path-check: ignore-file` marker, citing this record.
- The rule that billing stays in `apps/api/worker/billing/` no longer has a
  subject and leaves `AGENTS.md`.
- The retirement is temporary. Git keeps the code: restoring it means reverting
  the commit that deleted it and updating its dependencies, when hosted
  services are wanted again.
