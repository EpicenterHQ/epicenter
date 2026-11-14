# 0708. A namespace holds documents beside repositories under one resource grant

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at `https://git.epicenter.so/<id>.git`, the name as a free non-unique label, the renaming of the `namespace` tables to `repository` and `repository_member`, the deletion of the `repository` table, and "No table, column, file, identifier, route, or flag says namespace": a namespace stays the owner, a resource is addressed `<namespace>/<name>`, and a name is unique within its namespace across both kinds; [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at a repository's name being unique within its namespace: the uniqueness spans the namespace's documents too.
- **Relates:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) (documents as a second store), [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) (the owner namespace), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a sign-in grant names one repository).
- **Amended by:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at "One grant covers both kinds" and `share`/`unshare`: there are no per-resource grants; a team's members reach both kinds.
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at the document store: the folder is the only kind of store.
- **Unbuilt:** hosted documents; the tables that hold both kinds and their grants (one way: rename `repository` to `resource` with a `kind` column of `repository` or `document` and a `unique (namespace_id, name)` constraint, and rename `repository_grant` to `resource_grant`, keeping `repository_alias` on `resource.id`; existing ids, remotes, and grants would keep working); `share`, `unshare`, and `epicenter repos` for documents; the document endpoint; a sign-in grant that names a document.

## Context

Hosted Git keeps three tables in `packages/server/src/db/schema/`:

```txt
namespace          id (12 chars) · title · personal_account_id
repository         id (16 chars) · namespace_id · name · created_at     unique (namespace_id, name): repository_namespace_id_name_unique
repository_grant   repository_id · account_id · level: read | write
```

A folder's remote is `https://git.epicenter.so/<namespace>/<name>.git`.
`epicenter repos`, `share`, and `unshare`
(`packages/cli/src/repository-commands.ts`) list, grant, and revoke one
repository. `openRemote` reaches `<account>/<contract name>` (ADR-0700).

ADR-0612 decided a different address, `https://git.epicenter.so/<id>.git`,
with a non-unique name and the `namespace` tables renamed to `repository`.
None of it was built, and the code and ADR-0700 kept `<namespace>/<name>`.

[ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) adds documents: hosted Yjs documents that are not Git repositories.
A person shares a document the way they share a repository, and lists both
under their account.

## Decision

**A namespace owns two kinds of resource: repositories and documents.**
Membership (`namespace_member`, owner or member) reaches both kinds alike.

**One name list per namespace spans both kinds.** `<namespace>/<name>` names
exactly one resource, so `you/tabs` is a repository or a document, never
both. Names keep the current format: lowercase `a-z`, `0-9`, `.`, `_`, `-`,
at most 100 characters, never ending in `.git`.

**The kind is shown wherever a name is.** Each kind is reached through its
own endpoint:

```txt
repository   https://git.epicenter.so/<namespace>/<name>.git    Git routes serve only kind = repository
document     the document endpoint, addressed <namespace>/<name>   serves only kind = document
```

`epicenter repos` and the Epicenter app's list ([ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)) print the kind
beside every name.

**One grant covers both kinds.** A grant names one resource and a level,
`read` or `write`, whichever kind the resource is. `share <namespace>/<name>
<handle>` and `unshare` take a resource of either kind.

## Consequences

- A grant to `you/tabs` means the same thing whether `you/tabs` is a
  repository or a document. There is one sharing model to build, test, and
  explain.
- Moving an app between stores ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)'s export and import) cannot create
  the new resource under the old name while the old one exists. The person
  deletes the old resource first or picks another name.
- Every route checks `kind` before serving. A Git fetch of a document's name
  is refused, and the document endpoint refuses a repository's name.
- ADR-0612's id-addressed remote is withdrawn. Renaming a resource changes
  its address, which `repository_alias` covers for repositories only.

## Considered alternatives

- **Separate namespaces for repositories and documents.** Two name lists let
  `you/tabs` exist as both, and two grant tables mean two sharing models.
- **A grant naming `kind` and an id, with no shared table.** No foreign key
  reaches the target, and uniqueness across kinds needs a trigger.
- **ADR-0612's `<id>.git` address.** Unbuilt; current clones and `openRemote`
  already address `<namespace>/<name>`.
