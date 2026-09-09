# apps/self-host

Community-supported self-hosting, not operated by Epicenter. The current token
runtime and its configuration are described in README.md. The active library
ownership plan replaces shared bearer identity with admitted named users; do not
apply the former token-only prohibitions to that work.

## Deployment constraints

- Keep Cloud billing in `apps/api/worker/billing/`. Do not add `autumn-js`,
  `AUTUMN_SECRET_KEY`, or `/api/billing/*` routes here.
- Implement the same authentication and library ownership contract on Worker
  and Bun. Runtime storage and synchronization adapters may differ.
- Named-user sign-in follows ADR-0383: operator enrollment, passkeys by default,
  optional passwords only with complete setup/change/reset, and recovery of the
  same user. Removing a user disables admission; revoking sessions alone does not.
- Preserve the historical `instance` identity and its storage bytes until an
  explicit export/import operation is selected. Never assign that data to the
  first named user or silently reinterpret it as Shared.
- Shared access preserves the signed-in actor. Library selection does not replace
  the authenticated user with an `instance` or Shared principal.
- Shared server behavior belongs in `packages/server`; keep deployment composition
  here. Do not import the hosted Cloud auth composition to obtain named users.
- Treat wrangler bindings as operator-customized. Do not commit a working set of
  deployment bindings.
