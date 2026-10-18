# 0594. A hosted repository is reached only by the person who owns it

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at `namespace_member`, the role table, groups, "Sharing a folder is moving it into a group", and membership as the access rule: every namespace is one person's, and access is that person's account. [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at "A grant targets `*` or one namespace", the target column of the client table, the `referenceId` and `namespace_member` clauses of the access statement, and the target on the device approval page: a grant has no target, and a token reaches its person's own namespace. [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "approves the code with the chosen target": the consent page approves a device code with no choice of folders. [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at the kept `grant-target.ts` and "with a folder choice": the `/consent` page stays for device codes, and `grant-target.ts` is deleted. [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at "stores data repositories and nothing else": the service accepts any Git content a person pushes, and Epicenter offers no app hosting.
- **Amended by:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at "Every hosted repository belongs to one person's namespace" and the deletion of `namespace_member`: `namespace_member` stays as `repository_member`, and a repository's access list is its owners and members.
- **Amended by:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) at "a grant has no target, and a token reaches its person's own namespace": a grant names one repository.
- **Unbuilt:** all of it: the deletions below, the access statement keyed on `personal_account_id`, and the forward migration that drops `namespace_member` and makes `personal_account_id` not null. Before the migration ships, the owner audits production for namespaces whose `personal_account_id` is null and for tokens or consents whose `referenceId` starts with `ns:`.

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

**Every hosted repository belongs to one person's namespace, and only that
person's tokens reach it.** A request is allowed when the namespace in its
path has `personal_account_id` equal to the token's account and the token
carries the operation's audience and scope. There is no role, no member, and
no target:

```txt
namespace   id, title, personal_account_id   kept; one row per account, made with the account; personal_account_id not null
access      token's account = namespace.personal_account_id, plus audience and scope
```

**The hosted service accepts any Git content a person pushes, and Epicenter
offers no app hosting.** Nothing it stores is served or run as an app, and
a repository holds whatever the person chooses, within the store's limits,
such as Cloudflare Artifacts' 32 MB per file (ADR-0577). "Data repositories
and nothing else" (ADR-0593) is not a rule the service can check, so it is
not one.

Deleted:

- `namespace_member`, `namespaceMember`, `namespaceRelations`, and
  `namespaceMemberRelations`, and the member insert in
  `create_personal_namespace`, by one forward migration, which also makes
  `namespace.personal_account_id` not null;
- `packages/server/src/namespace-roles.ts`, the `role` of `ResourceAccess`,
  and both `roleAllows` checks in `routes/git.ts`;
- the target branch and membership join in `resource-access.ts`, and
  `AccountAccess.target`;
- the group aggregation in `listRepositories`: it lists the person's own
  repositories;
- `packages/server/src/auth/grant-target.ts`, its two routes
  (`/auth/grant-target/options` and `/auth/grant-target/select`), and
  `consentReferenceId` in `plugins.ts`;
- `GrantRequest.svelte`, `fetchGrantTargets`, `selectGrantTarget`, and
  `GrantTargetOption`. The consent page lists the requested scopes itself and
  answers Allow or Approve with no folder choice.

**Sharing returns only as its own product decision.** A record that adds
groups, collaborators, or a grant limited to some repositories decides
access again from this rule.

## Consequences

- Each Git request's access statement loses a join: one indexed lookup of the
  token and one of the namespace by id.
- A token issued under a grant that targeted `ns:<the person's own
  namespace>` reaches the same repositories as before. A token that targeted
  another namespace stops working, which the audit before the migration
  rules out.
- A namespace row with a null `personal_account_id` would fail the
  migration's not-null constraint. The audit finds any such row first, and
  the owner decides what becomes of its repositories before the migration
  runs.
- `GET /api/repos` keeps its `namespaces` array, with one entry.
  `ListedNamespace.role` (`packages/constants/src/repositories.ts:124`) and
  the group wording in `epicenter repos`' help
  (`packages/cli/src/cli.ts:188-189`) go.
- Tests that read or insert `namespace_member` rows
  (`packages/server/src/db/namespace.postgres.test.ts`,
  `packages/server/src/routes/git.postgres.test.ts`,
  `packages/server/src/test-helpers/oauth-client.ts`,
  `packages/server/src/test-helpers/oauth-checks.ts`) and the grant-target
  checks go with the code they test.
- A family or studio cannot share a folder on Epicenter's host. They can push
  it to any Git host they choose.

## Considered alternatives

- **Keep groups and membership for a future "Share…".** A table, a role
  model, a consent picker, and a join on every request, for a feature with no
  caller and no product design.
- **Keep the grant target for agents.** A device grant narrowed to one
  namespace narrows nothing when each person has exactly one namespace.
