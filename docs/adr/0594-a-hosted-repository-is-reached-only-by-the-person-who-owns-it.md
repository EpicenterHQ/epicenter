# 0594. Hosted access follows repository membership

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at `namespace_member`, the role table, groups, "Sharing a folder is moving it into a group", and membership as the access rule: every namespace is one person's, and access is that person's account. [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at "A grant targets `*` or one namespace", the target column of the client table, the `referenceId` and `namespace_member` clauses of the access statement, and the target on the device approval page: a grant has no target, and a token reaches its person's own namespace. [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "approves the code with the chosen target": the consent page approves a device code with no choice of folders. [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at the kept `grant-target.ts` and "with a folder choice": the `/consent` page stays for device codes, and `grant-target.ts` is deleted. [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at "stores data repositories and nothing else": the service accepts any Git content a person pushes, and Epicenter offers no app hosting.
- **Amended by:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at "Every hosted repository belongs to one person's namespace" and the deletion of `namespace_member`: `namespace_member` stays as `repository_member`, and a repository's access list is its owners and members.
- **Amended by:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at "a grant has no target, and a token reaches its person's own namespace": a grant names one repository.
- **Unbuilt:** repository membership, origin-specific grants, and the ID-based access path under ADR-0612 and ADR-0614.

## Context

ADR-0547 gave every repository one namespace and made access membership: a
person is a namespace with one member, and a group is a namespace with
several. ADR-0549 let a grant target `*` or one namespace, `ns:<id>`, chosen
on the consent page. Both are built:

- `namespace_member` and its relations
  (`packages/server/src/db/schema/namespace.ts:40-75`), filled for each new
  account by `create_personal_namespace`
  (`apps/api/drizzle/0003_personal_namespaces.sql`);
- `NAMESPACE_ROLES` and `roleAllows`
  (`packages/server/src/namespace-roles.ts`), called by the Git routes
  (`packages/server/src/routes/git.ts:338`, `:353`);
- the target and membership branches of `authorizeResourceRequest`
  (`packages/server/src/auth/resource-access.ts:173`, `:180-182`) and the
  `target` of `AccountAccess` (`:97`);
- `listRepositories`, which groups repositories by namespace, personal first
  then groups by title, and filters by target
  (`packages/server/src/repositories.ts:77-133`);
- `grantTarget` and `resolveConsentReferenceId`
  (`packages/server/src/auth/grant-target.ts`), wired at
  `packages/server/src/auth/plugins.ts:58` and `:63`;
- the picker "Which folders can it reach?"
  (`apps/api/ui/src/lib/auth/GrantRequest.svelte`), rendered on the consent
  page (`apps/api/ui/src/routes/consent/+page.svelte:117`), with
  `fetchGrantTargets` and `selectGrantTarget`
  (`apps/api/ui/src/lib/auth/oauth-request.ts`).

No product feature makes a group. "Share…" is unbuilt (ADR-0547), and
ADR-0593 removed the move that sharing would have used. Every namespace in
use is personal, so every target is `*` or the person's own namespace, and
every role is `owner`.

## Decision

**Hosted repository access follows its membership list and the request's authorization.**
Owners and members can read and push. Owners can change the label, delete
the repository, and manage membership (ADR-0612). Removing membership stops
future authorized fetches and pushes; it cannot recall an existing clone.

**Grants and tokens authorize hosted operations rather than local data use.**
A web app's Git grant names an account, web origin, and hosted repository.
The signed-in CLI holds an account grant. Requests also satisfy their token's
audience and operation scope (ADR-0614). Local opening and saving require no
grant under ADR-0633. Inference authorization grants no Git access (ADR-0634).

**The Git service accepts ordinary Git content without app hosting.**
It does not inspect files to decide whether the repository is data or source,
and it does not run pushed code. Store limits and history rules still apply.

## Consequences

- A personal namespace and its owner-only policy are retired.
- Repository membership and app consent answer different access questions.
- Choosing a schema file grants no additional data access.
