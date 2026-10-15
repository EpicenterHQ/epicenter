# 0547. Every repository has one owner namespace, and a person is a namespace of one

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** the `namespace` and `namespace_member` tables, the personal namespace made with each account, membership checks on Git requests, and groups with invitations.

## Context

Hosted repositories need an owner in their URL
([ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md)).
An account's id is Better Auth's generated id: 32 random characters in mixed
case, owned by the sign-in library. Git hosts give each repository exactly one
owner and let that owner be a person or an organization.

## Decision

**A repository belongs to exactly one namespace. A namespace has members, and
a person is a namespace with one member: themselves.**

```txt
namespace         id (12 characters, lowercase a-z and 0-9), title, personal_account_id (nullable, unique)
namespace_member  namespace_id, account_id, role ('owner' | 'member')
```

Whether a namespace is personal is the fact `personal_account_id`, never a
stored kind. A personal namespace always has exactly its account as its only
member, as `owner`; any other namespace is a group, which always has at least
one `owner`.

**Each account gets its personal namespace when it is created**, with that
account as its only `owner`. The namespace id is Epicenter's own, not the
account id: lowercase and dot-free, so it is safe in a URL and in the Artifacts
name `<namespace>.<name>`, and a namespace outlives any change in how accounts
are identified.

**Access is membership, one rule for every namespace.** A Git or LFS request is
allowed when its credential's account is a member of the namespace in its path:
`owner` and `member` may read and push; only an `owner` deletes a repository or
changes membership. A personal namespace and a group are checked the same way,
on every request, in the same query that resolves the credential; nothing is
cached, so removing a member takes effect at once.

**Sharing a folder is putting it in a group.** A group (a family, a studio)
has several members, each of whose devices clones its repositories and syncs
them; edits from different people merge the way edits from one person's two
machines do. There are no per-repository collaborators, and no one is added to
a personal namespace: to share, a person makes a group. The last owner of a
group cannot leave it without handing ownership to another member or deleting
the group. Deleting an account deletes its personal namespace and its
repositories, and asks first about any group it is the last owner of.

**People never see the word namespace.** On screen a personal namespace is
"Personal" and any other is a group, by its title; `namespace` is the word in
code, tables, and the URL's first segment.

**A readable handle is an alias, never the canonical owner.** If handles come,
`git.epicenter.so/braden/...` resolves to the namespace's id on the server; the
URL stored in `remote.origin.url` stays the id, so renaming a handle changes no
clone.

## Consequences

- Organizations need no second permission model: they are namespaces with
  more members.
- The Folders window groups a person's repositories by namespace, personal
  first.
- Each Git request joins one membership row onto the credential lookup it
  already makes; a sync is three or four requests.
- URLs are not readable until handles exist.

## Considered alternatives

- **The account id as the owner.** Mixed case, owned by the auth library, and
  it makes shared ownership a migration.
- **Per-repository collaborators.** A second permission model beside
  membership, for a case a small group covers.
- **A stored `kind` (`person` or `shared`).** A status beside the fact it
  restates; `personal_account_id` is the fact.
- **A read-only role.** Left out until a case needs it; adding one changes no
  URL and no table shape.
- **"Organization" or "team" on screen.** Both suggest a company; a family
  sharing groceries is a group.
- **Caching membership in the Worker.** Saves a join on a query already made,
  and delays removing a member.
- **Better Auth's organization plugin as the namespace table.** It brings
  invitations, but makes the owner of every repository an auth-library row and
  needs a personal organization per account anyway; its invitations can be
  adopted later on top of these tables.
- **Handles as canonical owners.** A rename would move every remote.
