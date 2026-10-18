# 0612. A namespace is one Git repository shared by its members

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at `https://git.epicenter.so/<namespace>/<name>.git`, Connect, and the proposed name: the remote is `https://git.epicenter.so/<namespace id>.git` and nothing proposes a name; [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) at "A repository belongs to exactly one namespace", the role table, personal and group kinds, and "People never see the word namespace": a namespace is one repository, owners and members are its only relation, and people choose namespaces by name; [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) at "Every hosted repository belongs to one person's namespace" and the deletion of `namespace_member`: a namespace has owners and members, and `namespace_member` stays; [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) at principles 2 and 10: they read as restated below.
- **Relates:** [0611](0611-epicenters-data-is-namespaces-of-typed-markdown-in-git.md) (the v1 model and its build order), [0614](0614-a-browser-app-is-identified-by-its-origin.md) (a grant targets one namespace).
- **Unbuilt:** all of it: the `/<namespace id>.git` route; the deletion of the repository registry and `namespace.personal_account_id`; a namespace's name as its label on screen; creating a namespace from consent; and invites, which come later.

## Context

A hosted folder lives at `https://git.epicenter.so/<namespace>/<name>.git`
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).
`packages/server/src/routes/git.ts` serves that grammar, and
`packages/server/src/repositories.ts` with the `repository` and
`repository_alias` tables in `packages/server/src/db/schema/repository.ts`
registers each repository under its namespace, with rename, move, and alias
handling. `packages/server/src/db/schema/namespace.ts` gives every account a
personal namespace through `personal_account_id` and the
`user_personal_namespace` trigger, and shows it as "Personal"
([ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)).
[ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md)
narrowed every namespace to one person. On 2026-10-18 the owner chose a
namespace as the unit that many apps and several people share, so one person's
repositories under one person's namespace leaves a team nowhere to keep shared
data.

## Decision

**A namespace is one Git repository at `https://git.epicenter.so/<namespace id>.git`.**
The id (`namespace.id`, twelve characters of `a-z0-9`) is its identity and
never changes. Its name is a free, non-unique label, and no handle registry
exists. Deleted: repository names below a namespace; the
`<namespace>/<name>.git` route grammar in `packages/server/src/routes/git.ts`;
`packages/server/src/repositories.ts` with the `repository` and
`repository_alias` tables; `epicenter repos`; Connect; and `sync --to`. Cost:
the permission unit is the whole namespace, and every origin that opens one
downloads its whole current tree.

**A namespace has owners and members, many to many, and no role beyond
owner.** `namespace_member` keeps its `role` of `owner` or `member`. There is
no nesting, no personal or org kind, and no "main" namespace. Signup creates a
first namespace, as the `user_personal_namespace` trigger does now; invites
come later. Deleted: `namespace.personal_account_id` and the "Personal" label.
Cost: every member can change everything in the namespace.

```txt
namespace         id (identity) · name (label, not unique)
namespace_member  namespace_id · account_id · role: owner | member
                  an account belongs to many namespaces; a namespace has many accounts
```

**People choose a namespace by its name, and code addresses it by its id.**
The CLI resolves a name among the account's namespaces and refuses an
ambiguous one. Consent resolves a suggested name as
[0614](0614-a-browser-app-is-identified-by-its-origin.md) states.

The principles of [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
that change read:

- **Principle 2.** A namespace is one Git repository a person or several
  people own, cloned into any directory, with no second local name.
- **Principle 10.** Epicenter offers no app hosting; its Git service accepts
  any Git content pushed to a namespace, and only that namespace's owners and
  members reach it.

## Consequences

- Every app a person uses inside one namespace shares one repository, one
  history, and one sync.
- Revoking a member stops future fetches and pushes and does not recall a
  clone the member already holds.
- A large archive is its own namespace, so it never slows the namespaces apps
  open in a tab.
- Two namespaces with one name are told apart by id on screen and by a short
  id suffix in `~/Epicenter`.

## Considered alternatives

- **One repository per app inside a namespace (`<namespace>/<repo>.git`).**
  Every app then names a repository, which is app identity under another name,
  and sharing a table across apps needs a link across repositories.
- **Personal-only namespaces (ADR-0594).** A team then has no place to keep
  shared data without moving repositories between people.
- **Unique handles.** A registry of names adds squatting, renames, and
  redirects to a label that only has to be readable.
