# 0612. A repository is shared by the people on its access list

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `https://git.epicenter.so/<namespace>/<name>.git`, Connect's proposed name, "unique within its namespace", and the `repository` and `repository_alias` tables: the remote is `https://git.epicenter.so/<id>.git`, and a name is a label; [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "A repository belongs to exactly one namespace", the personal namespace, and "People never see the word namespace": the `namespace` and `namespace_member` tables are renamed `repository` and `repository_member`, a repository has owners and members, and no code or schema says namespace; [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "Every hosted repository belongs to one person's namespace" and the deletion of `namespace_member`: `namespace_member` stays as `repository_member`, and a repository's access list is its owners and members; [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) at "offers no rename": a repository's name changes freely, and nothing moves; [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) at the Folder noun: what a person shares and an app opens is a repository; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at "A folder's directory name is its hosted repository's name, on every device and in every origin": a clone lives in a directory of any name.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the Git service), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a grant names one repository).
- **Unbuilt:** all of it: the `/<id>.git` route; renaming the `namespace` tables and every `namespace` identifier to `repository`; storage named by the renamed table's id; renaming a repository's name; the deletion of the second registry (`repository` and `repository_alias`) and of `personal_account_id`; `GET /api/repos` listing by id and name from the one registry; creating a repository at consent; and invites.

## Context

A hosted folder lives at `https://git.epicenter.so/<namespace>/<name>.git`
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).
The server keeps two registries: `namespace`
(`packages/server/src/db/schema/namespace.ts`), one per account through
`personal_account_id` and the migration
`apps/api/drizzle/0003_personal_namespaces.sql`
([ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)),
and `repository` with `repository_alias`
(`packages/server/src/db/schema/repository.ts`), which names each
repository uniquely within its namespace and whose id names storage.
`packages/server/src/repositories.ts` registers repositories under a
namespace, and `GET /api/repos` lists them by namespace.
[ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md)
narrowed every namespace to one person, and
[ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md)
withdrew renaming because a name was part of every URL.

On 2026-10-18 the owner chose one Git repository as the unit several apps
and several people share, which leaves the namespace naming nothing.

## Decision

**A repository is one Git repository at `https://git.epicenter.so/<id>.git`,
with one branch, `main`.** Every clone commits to `main` and syncs it. Its
id is its identity and never changes. URLs, grants, and clones use the
id. Its name is a free, non-unique label, shown to people and changeable at
any time without breaking anything.

**The noun is repository in code, in database tables, on the wire, and in
the CLI.** No table, column, file, identifier, route, or flag says
namespace.

**A repository has owners and members, and that list is the only guard on
who reaches it.** The two roles are those of ADR-0547's role table: both
read and push; an owner also renames, deletes, and changes members. The
server keeps one registry, the existing `namespace` tables renamed:

```txt
repository         id (identity, names storage) · name (label, not unique)     was namespace: id, title
repository_member  repository_id · account_id · role: owner | member           was namespace_member
                   an account is on many repositories; a repository has many accounts
```

`packages/server/src/db/schema/namespace.ts`, `namespaceMember`, and
`packages/server/src/namespace-roles.ts` with `NamespaceRole` are renamed
with the tables. Deleted: the second registry, which is the `repository` and
`repository_alias` tables of `packages/server/src/db/schema/repository.ts`,
and registration under a namespace in `packages/server/src/repositories.ts`;
`personal_account_id` with the `user_personal_namespace`
trigger of `apps/api/drizzle/0003_personal_namespaces.sql`; the
`<namespace>/<name>.git` grammar in `packages/server/src/routes/git.ts`; and
Connect. Cost: the permission unit is the whole repository, and everyone on
its list can change everything in it.

**People choose a repository by its name, and code addresses it by its
id.** A clone lives in a directory of any name, which is never the
repository's identity.

**A repository is created at consent, and one route lists a person's
repositories.** Consent offers "Create a repository named studio", with
the name an app suggested
([ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)), and the
person who creates it is its first owner. `GET /api/repos` lists the
repositories the signed-in person is on, each by id and name, from
`repository_member`; `epicenter repos` and `epicenter clone` read it
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

## Consequences

- Several apps and several people share one repository, one history, and
  one sync.
- Renaming a repository changes what people see and nothing a clone, a
  grant, or a URL holds.
- Two repositories with one name are told apart by their ids, and
  `epicenter clone` given a name two of them share asks for the id.
- No client chooses a branch: every app, the CLI, and the data browser
  sync `main`.
- Removing a member stops that member's future fetches and pushes and does
  not recall a clone already made.
- A large archive is its own repository, so it never slows the
  repositories apps open in a tab.

## Considered alternatives

- **Repositories under a namespace (`<namespace>/<name>.git`).** A second
  registry and a second name in every URL, so a rename breaks clones and
  needs aliases (ADR-0593).
- **One repository per app.** Every app names a repository, and sharing a
  table across apps needs a link across repositories.
- **`namespace` kept in code and schema while people see repository.** A
  second name for one thing, so every reader of the code translates
  between the two.
- **Keep the second registry and drop `namespace`.** Its `repository` rows
  hang off a namespace and carry a unique name, so every row and every
  member would move to a new table anyway.
- **Unique names.** A registry of names adds squatting and redirects to a
  label that only has to be readable.
