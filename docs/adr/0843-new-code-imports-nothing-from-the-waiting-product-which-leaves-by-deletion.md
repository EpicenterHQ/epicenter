# 0843. New code imports nothing from the waiting product, which leaves by deletion

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the direction, and the product that waits), [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (what the new code builds), [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md).
- **Spec:** [specs/20261107T222922-epicenter-is-where-personal-software-lives.md](../../specs/20261107T222922-epicenter-is-where-personal-software-lives.md), whose build order carries this out.
- **Unbuilt:** the tag, the import check, and every deletion.

## Context

ADR-0840 set the folder sync product aside, but its code is most of this
repository: `packages/folder`, `server`, `definition`, `local`,
`tauri-plugin-epicenter-folder`, and `tauri-epicenter-standalone`, about 44,000
lines, and the apps built on them (`apps/epicenter`, `vocab`, `todos`,
`honeycrisp`, `capture`, `messages`), about 20,000 more. Nearly everything else
imports it too: Whispering, which has users; `apps/api`; `packages/account`,
`ai`, `svelte`, and `recorder`; and the CLI. Deleting it in one move breaks
Whispering. Leaving it in place while the new code grows beside it invites the
slow version of the same mistake: a new package that imports one helper from
`definition`, then a type from `folder`, until the new product is the old one
with a different front door.

## Decision

**New code imports nothing from the waiting product.** `@epicenter/app`, the
rewritten `@epicenter/cli`, and every app written to ADR-0841 import nothing
from `@epicenter/definition`, `folder`, `server`, or `local`, nor either
folder-sync native package. A check in `bun run check` fails when one does.
Something worth keeping from the old code (the front-matter rule, a Keychain
helper) is copied into the new code and owned there, never imported.

**The waiting product leaves by deletion, never by adaptation.** Nothing becomes
a layer between the two: the new code reads no `epicenter.json`, no sync
ledger, and no old folder layout. A package is deleted, whole, in its own
commit, when nothing imports it any more.

**A tag keeps it.** Before the first deletion, the tag `folder-sync-product`
marks the last commit with the old product whole, so returning to it is a
checkout. No branch keeps it alive, because a branch asks to be maintained.

**The order follows the imports.**
1. The old folder apps and the Epicenter desktop app are deleted right after the
   tag: nothing imports them.
2. `packages/cli` is rewritten in place, so there is one `epicenter` command.
   Its folder, sync, server, sign-in, and Messages commands are deleted, and with
   them its imports of the old product.
3. `apps/api` loses its folder sync routes; sign-in, AI, and billing stay.
   `packages/account`, `ai`, `svelte`, and `recorder` cut their imports.
4. Whispering is untangled last, because it ships. When it no longer imports
   the old product, `packages/folder`, `server`, `definition`, `local`, and the
   two native packages are deleted.

**Docs follow the code.** `docs/architecture.md`, `docs/CONTEXT.md`, and a
package's README are rewritten when the code they describe is deleted, not
before.

## Considered alternatives

- **Delete the whole product at once.** Breaks Whispering and every package
  that imports a type from it, in one change too large to review.
- **A new CLI package beside the old one.** Two programs named `epicenter`, and
  an agent reading either cannot tell which is current. The old CLI's parser,
  operation table, MCP server, and output rules are already the right bones.
- **Freeze the old apps in the tree.** Every search, typecheck, and agent keeps
  meeting a product that is not being built. The tag keeps them as well, at no
  cost.
- **Keep `packages/definition` as the notes library.** It imports
  `packages/folder` and carries the sync product's contracts. A notes library,
  when an app needs one, is new code that copies the front-matter rule.
- **A long-lived branch for the old product.** Invites fixes on it, and the two
  drift. A tag is a fact; a branch is a promise.

## Consequences

- Until Whispering is untangled, the old packages stay in the tree, and
  `bun run typecheck` still checks them.
- The new code repeats a few small things the old code had (a Keychain wrapper,
  an atomic file write). Each copy is owned by the new code and free to change.
- Anything the old product can do that the new one cannot (the desktop app,
  web and phone apps, sign-in, sharing) is gone from `main` until it is rebuilt
  to ADR-0841, or the tag is checked out.
